/**
 * Global search (roadmap 11.5): GET /api/search finds tasks, task notes,
 * messages, knowledge, files, projects, customers and agents, and never
 * returns what the viewer may not open: another person's private chat, an
 * agent pair thread (non-admins), records outside a restricted member's
 * scope, or anything from another company.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent } from "./_helper";
import { actAs, call, seedHuman, seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

type Result = { type: string; id: string; title: string; snippet: string; highlights: [number, number][]; href: string; context: string | null; updatedAt: string };
type Body = { query: string; results: Result[]; nextCursor: string | null };

async function newCompany(name: string) {
    const db = await getDb();
    const { users, companies } = await getSchema();
    const [creator] = await db.insert(users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [company] = await db.insert(companies).values({ name, createdByUserId: creator.id, directChatMode: "private" }).returning();
    return company.id;
}

async function world() {
    await resetDb();
    const db = await getDb();
    const { taskEvents, scopedResources, artifacts, tasks } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const companyId = await newCompany("Search Co");
    const work = await seedTwoTenantsOfWork(companyId);
    await db.update(tasks).set({ inputJson: { title: "Quarterly zephyr invoice", description: "Send the invoice to the café owner" } }).where(eq(tasks.id, work.taskIn.id));
    await db.update(tasks).set({ inputJson: { title: "Outbound zephyr campaign" } }).where(eq(tasks.id, work.taskOut.id));
    const agentIn = await seedAgent(companyId, { name: "Agent In", role: "zephyr analyst" });
    const agentOut = await seedAgent(companyId, { name: "Agent Out", role: "zephyr outsider" });

    const owner = await seedHuman(companyId, "owner");
    const admin = await seedHuman(companyId, "admin");
    const member = await seedHuman(companyId, "member");
    const restricted = await seedHuman(companyId, "member", { scope: { mode: "restricted", agentIds: [agentIn.id], customerIds: [work.customerIn.id] } });

    const [noteIn] = await db.insert(taskEvents).values({
        companyId, taskId: work.taskIn.id, eventType: "task_note", actorType: "agent", actorId: agentIn.id,
        payloadJson: { note: "Checked zephyr pricing with the café" },
    }).returning();
    await db.insert(taskEvents).values({
        companyId, taskId: work.taskIn.id, eventType: "task_claimed", actorType: "agent", actorId: agentIn.id,
        payloadJson: { note: "zephyr should not match a non-note event" },
    });

    const { ensureTeamThread, ensureDirectThread, appendThreadMessage } = await import("@/lib/control-plane");
    const { ensureAgentPairThread } = await import("@/lib/groups");
    const team = await ensureTeamThread(companyId);
    const teamMessage = await appendThreadMessage({ companyId, threadId: team.id, senderType: "human", senderId: owner.userId, text: "zephyr team update <script>alert(1)</script>" });
    const privateThread = await ensureDirectThread(companyId, agentIn.id, owner.userId);
    assert.equal(privateThread.ownerUserId, owner.userId);
    const privateMessage = await appendThreadMessage({ companyId, threadId: privateThread.id, senderType: "human", senderId: owner.userId, targetAgentId: agentIn.id, text: "zephyr secret plan" });
    const pair = await ensureAgentPairThread(companyId, agentIn.id, agentOut.id);
    const pairMessage = await appendThreadMessage({ companyId, threadId: pair.id, senderType: "agent", senderId: agentIn.id, targetAgentId: agentOut.id, text: "zephyr pair handoff" });

    const [noteCompany] = await db.insert(scopedResources).values({ companyId, scopeType: "company", provider: "knowledge", resourceType: "note", name: "Zephyr playbook", configText: "How we run zephyr" }).returning();
    const [noteOut] = await db.insert(scopedResources).values({ companyId, scopeType: "customer", scopeId: work.customerOut.id, provider: "knowledge", resourceType: "note", name: "Out customer zephyr", configText: "zephyr private", secretText: "hunter2-zephyr" }).returning();
    const [deletedNote] = await db.insert(scopedResources).values({ companyId, scopeType: "company", provider: "knowledge", resourceType: "note", name: "Deleted zephyr", configText: "gone", deletedAt: new Date() }).returning();

    const file = (projectId: string | null, title: string) => ({
        companyId, projectId, title, kind: "document", contentType: "text/plain", contentText: `${title} body with zephyr`,
        sha256: randomUUID(), sizeBytes: 10, createdByType: "human",
    });
    const [fileIn] = await db.insert(artifacts).values(file(work.projectIn.id, "Zephyr brief in")).returning();
    const [fileOut] = await db.insert(artifacts).values(file(work.projectOut.id, "Zephyr brief out")).returning();

    return { companyId, ...work, agentIn, agentOut, owner, admin, member, restricted, noteIn, teamMessage, privateMessage, pairMessage, noteCompany, noteOut, deletedNote, fileIn, fileOut };
}

async function search(user: { userId: string; sessionId: string }, query: string, extra = "") {
    actAs(user);
    const { GET } = await import("@/app/api/search/route");
    const res = await call(GET as never, `/api/search?q=${encodeURIComponent(query)}${extra}`);
    actAs(null);
    assert.equal(res.status, 200, res.text);
    return res.json as unknown as Body;
}

const ids = (body: Body) => new Set(body.results.map((r) => r.id));

maybe("search: finds a task, its note, a message, knowledge, a file and an agent; snippets are plain text", async () => {
    const w = await world();
    const body = await search(w.owner, "zephyr", "&limit=50");
    const found = ids(body);
    for (const [label, id] of Object.entries({ task: w.taskIn.id, note: w.noteIn.id, team: w.teamMessage.id, own: w.privateMessage.id, pair: w.pairMessage.id, knowledge: w.noteCompany.id, file: w.fileIn.id, agent: w.agentIn.id })) {
        assert.ok(found.has(id), `owner should find ${label}`);
    }
    assert.ok(!found.has(w.deletedNote.id), "deleted knowledge is never returned");
    const task = body.results.find((r) => r.id === w.taskIn.id)!;
    assert.equal(task.type, "task");
    assert.equal(task.href, `/projects?project=${w.projectIn.id}&task=${w.taskIn.id}`);
    const team = body.results.find((r) => r.id === w.teamMessage.id)!;
    assert.equal(team.type, "message");
    assert.ok(!/[<>]/.test(team.snippet), `snippet carries no markup: ${team.snippet}`);
    assert.ok(team.highlights.length > 0);
    const [start, end] = team.highlights[0];
    assert.equal(team.snippet.slice(start, end).toLowerCase(), "zephyr");
    assert.ok(body.results.every((r) => !r.snippet.includes("hunter2")), "secret text is never indexed");

    // Accent folding, prefix matching, and the type filter.
    assert.ok(ids(await search(w.owner, "cafe")).has(w.noteIn.id), "cafe finds café");
    assert.ok(ids(await search(w.owner, "zeph")).has(w.taskIn.id), "the last word matches as a prefix");
    const messagesOnly = await search(w.owner, "zephyr", "&type=message");
    assert.ok(messagesOnly.results.length > 0 && messagesOnly.results.every((r) => r.type === "message"));
    const notes = await search(w.owner, "zephyr", "&type=task");
    assert.ok(!ids(notes).has(w.agentIn.id));
    assert.equal(notes.results.filter((r) => r.title.startsWith("Note on")).length, 1, "only note events are indexed");
});

maybe("search: pages with a cursor without repeating results", async () => {
    const w = await world();
    const first = await search(w.owner, "zephyr", "&limit=3");
    assert.equal(first.results.length, 3);
    assert.ok(first.nextCursor);
    const second = await search(w.owner, "zephyr", `&limit=3&cursor=${encodeURIComponent(first.nextCursor!)}`);
    assert.ok(second.results.length > 0);
    for (const r of second.results) assert.ok(!ids(first).has(r.id), "pages do not overlap");
});

maybe("search: never returns another person's private chat message", async () => {
    const w = await world();
    for (const viewer of [w.member, w.admin, w.restricted]) {
        const body = await search(viewer, "zephyr secret plan", "&limit=50");
        assert.ok(!ids(body).has(w.privateMessage.id), "a private chat stays with its owner");
        assert.ok(body.results.every((r) => !r.snippet.includes("secret plan")));
    }
    assert.ok(ids(await search(w.owner, "secret")).has(w.privateMessage.id));
});

maybe("search: an agent pair thread is visible to owners/admins only", async () => {
    const w = await world();
    assert.ok(ids(await search(w.admin, "handoff")).has(w.pairMessage.id));
    assert.ok(!ids(await search(w.member, "handoff")).has(w.pairMessage.id));
});

maybe("search: a restricted member only gets in-scope results", async () => {
    const w = await world();
    const found = ids(await search(w.restricted, "zephyr", "&limit=50"));
    for (const id of [w.taskIn.id, w.noteIn.id, w.fileIn.id, w.noteCompany.id, w.agentIn.id, w.teamMessage.id]) assert.ok(found.has(id), `in scope: ${id}`);
    for (const id of [w.taskOut.id, w.fileOut.id, w.noteOut.id, w.agentOut.id, w.pairMessage.id]) assert.ok(!found.has(id), `out of scope: ${id}`);
    const out = ids(await search(w.restricted, "out", "&limit=50"));
    for (const id of [w.customerOut.id, w.projectOut.id, w.taskOut.id]) assert.ok(!out.has(id), `out of scope: ${id}`);
    const inside = ids(await search(w.restricted, "in", "&limit=50"));
    assert.ok(inside.has(w.customerIn.id) && inside.has(w.projectIn.id));
});

maybe("search: companies are isolated", async () => {
    const w = await world();
    const db = await getDb();
    const { customers, projects, tasks } = await getSchema();
    const otherCompany = await newCompany("Other Co");
    const [customer] = await db.insert(customers).values({ companyId: otherCompany, name: "Zephyr elsewhere" }).returning();
    const [project] = await db.insert(projects).values({ companyId: otherCompany, goal: "Zephyr elsewhere", status: "active", customerId: customer.id }).returning();
    const [task] = await db.insert(tasks).values({ companyId: otherCompany, projectId: project.id, taskType: "work", state: "inbox", inputJson: { title: "Zephyr elsewhere" } }).returning();
    const otherOwner = await seedHuman(otherCompany, "owner");

    const mine = ids(await search(w.owner, "zephyr", "&limit=50"));
    for (const id of [customer.id, project.id, task.id]) assert.ok(!mine.has(id));
    const theirs = await search(otherOwner, "zephyr", "&limit=50");
    assert.deepEqual([...ids(theirs)].sort(), [customer.id, project.id, task.id].sort());
});

maybe("search: injection-ish and malformed input never errors", async () => {
    const w = await world();
    const inputs = [
        "zephyr' OR 1=1 --", "a & b | !c", "<->", "):*", "foo:* & !bar", "\\", "%_", "'; DROP TABLE tasks; --",
        "\u0000zephyr", "\u0002x\u0003", "ž", "x".repeat(500), "", " ", "😀 zephyr", "(zephyr", "zephyr*",
    ];
    for (const q of inputs) {
        const body = await search(w.owner, q);
        assert.ok(Array.isArray(body.results), q);
    }
    for (const extra of ["&type=nope", "&limit=-5", "&limit=abc", "&cursor=%%%", "&cursor=eyJvIjo5OTk5OTl9"]) {
        const body = await search(w.owner, "zephyr", extra);
        assert.ok(Array.isArray(body.results), extra);
    }
    // The tasks table is still there.
    const db = await getDb();
    const { tasks } = await getSchema();
    assert.ok((await db.select({ id: tasks.id }).from(tasks)).length >= 2);
});

maybe("search: signed-out callers are refused", async () => {
    await world();
    actAs(null);
    const { GET } = await import("@/app/api/search/route");
    const res = await call(GET as never, "/api/search?q=zephyr");
    assert.ok(res.status === 401 || res.status === 403, String(res.status));
});
