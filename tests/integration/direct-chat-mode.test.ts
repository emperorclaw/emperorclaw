import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";

/**
 * Per-company direct-chat mode (companies.direct_chat_mode): "shared" keeps one
 * direct thread per agent for everyone; "private" gives each person their own
 * thread with an agent, while system traffic goes to the agent's shared
 * Operations thread.
 */
const maybe = dbAvailable ? test : test.skip;

async function seedTeam(mode: "shared" | "private") {
    await resetDb();
    const db = await getDb();
    const { users, companies, companyMembers } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { companyId, userId: ownerId } = await seedCompanyWithToken();
    const [b] = await db.insert(users).values({ email: `b-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    await db.insert(companyMembers).values([
        { companyId, userId: ownerId, role: "owner" },
        { companyId, userId: b.id, role: "member" },
    ]);
    await db.update(companies).set({ directChatMode: mode }).where(eq(companies.id, companyId));
    const agent = await seedAgent(companyId, { name: "Scout", provider: "hermes" });
    return { companyId, userA: ownerId, userB: b.id, agent };
}

async function humanParticipants(threadId: string) {
    const db = await getDb();
    const { threadParticipants } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const rows = await db.select({ ref: threadParticipants.participantRef }).from(threadParticipants)
        .where(and(eq(threadParticipants.threadId, threadId), eq(threadParticipants.participantType, "human")));
    return rows.map((r) => r.ref).sort();
}

async function tokenForAgent(companyId: string, agentId: string): Promise<string> {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const raw = `ec_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({
        companyId, agentId, tokenHash: createHash("sha256").update(raw).digest("hex"), name: `agent-${agentId}`, scope: "mcp_full",
    });
    return raw;
}

maybe("shared mode: one thread per agent for everyone, with system traffic in it too", async () => {
    const { companyId, userA, userB, agent } = await seedTeam("shared");
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const a = await ensureDirectThread(companyId, agent.id, userA);
    const b = await ensureDirectThread(companyId, agent.id, userB);
    const system = await ensureDirectThread(companyId, agent.id, null);
    assert.equal(a.id, b.id);
    assert.equal(a.id, system.id);
    assert.equal(a.ownerUserId, null);
    assert.equal(a.directAgentId, agent.id);
    assert.equal(a.title, "Direct Agent Thread");
    assert.deepEqual(await humanParticipants(a.id), [userA, userB].sort(), "every member is a participant");
});

maybe("private mode: each person gets their own thread, with only them as the human participant", async () => {
    const { companyId, userA, userB, agent } = await seedTeam("private");
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const a = await ensureDirectThread(companyId, agent.id, userA);
    const b = await ensureDirectThread(companyId, agent.id, userB);
    assert.notEqual(a.id, b.id);
    assert.equal(a.ownerUserId, userA);
    assert.equal(b.ownerUserId, userB);
    assert.deepEqual(await humanParticipants(a.id), [userA]);
    assert.deepEqual(await humanParticipants(b.id), [userB]);
    assert.equal((await ensureDirectThread(companyId, agent.id, userA)).id, a.id, "reopening finds the same thread");
});

maybe("private mode: concurrent opens for one person create exactly one thread", async () => {
    const { companyId, userA, agent } = await seedTeam("private");
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const threads = await Promise.all(Array.from({ length: 6 }, () => ensureDirectThread(companyId, agent.id, userA)));
    assert.equal(new Set(threads.map((t) => t.id)).size, 1);
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const rows = await db.select({ id: messageThreads.id }).from(messageThreads)
        .where(and(eq(messageThreads.companyId, companyId), eq(messageThreads.ownerUserId, userA)));
    assert.equal(rows.length, 1);
});

maybe("private mode: system paths without a person use the shared Operations thread", async () => {
    const { companyId, userA, userB, agent } = await seedTeam("private");
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const mine = await ensureDirectThread(companyId, agent.id, userA);
    const ops = await ensureDirectThread(companyId, agent.id, null);
    const outsider = await ensureDirectThread(companyId, agent.id, randomUUID());
    assert.notEqual(ops.id, mine.id);
    assert.equal(ops.ownerUserId, null);
    assert.equal(ops.title, "Scout · Operations");
    assert.equal(outsider.id, ops.id, "someone outside the company never gets a private thread");
    assert.deepEqual(await humanParticipants(ops.id), [userA, userB].sort());

    // Back to shared: new chats use the shared thread, private ones stay private.
    const db = await getDb();
    const { companies } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companies).set({ directChatMode: "shared" }).where(eq(companies.id, companyId));
    assert.equal((await ensureDirectThread(companyId, agent.id, userA)).id, ops.id);
    assert.deepEqual(await humanParticipants(mine.id), [userA]);
});

maybe("sync delivers both people's private messages to the agent", async () => {
    const { companyId, userA, userB, agent } = await seedTeam("private");
    const token = await tokenForAgent(companyId, agent.id);
    const { ensureDirectThread, appendThreadMessage } = await import("@/lib/control-plane");
    const a = await ensureDirectThread(companyId, agent.id, userA);
    const b = await ensureDirectThread(companyId, agent.id, userB);
    const since = new Date(Date.now() - 60_000).toISOString();
    const fromA = await appendThreadMessage({ companyId, threadId: a.id, senderType: "human", senderId: userA, targetAgentId: agent.id, text: "from A" });
    const fromB = await appendThreadMessage({ companyId, threadId: b.id, senderType: "human", senderId: userB, targetAgentId: agent.id, text: "from B" });

    const route = await import("@/app/api/mcp/messages/sync/route");
    const res = await route.GET(makeRequest(
        `http://localhost/api/mcp/messages/sync?agentId=${agent.id}&since=${encodeURIComponent(since)}`,
        { headers: { authorization: `Bearer ${token}` } },
    ));
    assert.equal(res.status, 200);
    const json = await res.json() as { messages: Array<{ id: string; threadId: string }> };
    const byId = new Map(json.messages.map((m) => [m.id, m.threadId]));
    assert.equal(byId.get(fromA.id), a.id);
    assert.equal(byId.get(fromB.id), b.id);
});

maybe("privacy: another member cannot see, join or be notified about a private thread", async () => {
    const { companyId, userA, userB, agent } = await seedTeam("private");
    const { ensureDirectThread, markThreadRead, appendThreadMessage, getDirectThreadForUser } = await import("@/lib/control-plane");
    const { loadThreadVisibility } = await import("@/lib/agent-activity");
    const a = await ensureDirectThread(companyId, agent.id, userA);

    const forB = await loadThreadVisibility(companyId, [a.id], userB);
    const forA = await loadThreadVisibility(companyId, [a.id], userA);
    assert.equal(forB.visible(a.id), false, "B's view redacts A's private thread activity");
    assert.equal(forA.visible(a.id), true);

    await markThreadRead(companyId, a.id, userB);
    assert.deepEqual(await humanParticipants(a.id), [userA], "opening it does not make B a participant");
    assert.equal(await getDirectThreadForUser(companyId, agent.id, a.id, userB), null);
    assert.equal((await getDirectThreadForUser(companyId, agent.id, a.id, userA))?.id, a.id);

    // An agent's decision in A's thread notifies A (not B), linking that thread.
    const db = await getDb();
    const { users, notifications } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(users).set({ displayName: "Bea" }).where(eq(users.id, userB));
    await appendThreadMessage({
        companyId, threadId: a.id, senderType: "agent", senderId: agent.id,
        text: "@Bea which one?\n```choices\n- One\n- Two\n```",
    });
    const rows = await db.select({ userId: notifications.userId, link: notifications.link }).from(notifications)
        .where(eq(notifications.companyId, companyId));
    assert.deepEqual(rows.map((r) => r.userId), [userA]);
    assert.equal(rows[0].link, `/messages?agent=${agent.id}&thread=${a.id}`);
});

maybe("task wakes from one person go to that person's private thread", async () => {
    const { companyId, userA, agent } = await seedTeam("private");
    const db = await getDb();
    const { projects, tasks, taskEvents, threadMessages, messageThreads } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const [project] = await db.insert(projects).values({ companyId, goal: "Ship", status: "active" }).returning();
    const [task] = await db.insert(tasks).values({
        companyId, projectId: project.id, taskType: "build", state: "inbox", assignedAgentId: agent.id, inputJson: { title: "Build it" },
    }).returning();
    await db.insert(taskEvents).values({ companyId, taskId: task.id, eventType: "task_created", actorType: "human", actorId: userA });

    const { wakeAgentOnTaskAssignment } = await import("@/lib/task-wake");
    await wakeAgentOnTaskAssignment({ companyId, task, reason: "assigned" });
    const [wake] = await db.select({ ownerUserId: messageThreads.ownerUserId }).from(threadMessages)
        .innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
        .where(and(eq(threadMessages.companyId, companyId), eq(threadMessages.senderType, "system")));
    assert.equal(wake?.ownerUserId, userA);
});

maybe("migration 0062: existing companies become shared, new ones start private, direct threads learn their agent", async () => {
    const db = await getDb();
    const { sql } = await import("drizzle-orm");
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");

    const name = `ec_mig_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await db.execute(sql.raw(`CREATE DATABASE ${name}`));
    const url = new URL(process.env.POSTGRES_CONNECTION_STRING!);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.toString() });
    const migrations = path.resolve("src/db/migrations");
    const before = mkdtempSync(path.join(tmpdir(), "ec-mig-"));
    try {
        // The chain up to 0061, i.e. a database from before the setting existed.
        cpSync(migrations, before, { recursive: true });
        const journalPath = path.join(before, "meta", "_journal.json");
        const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
        const cut = journal.entries.findIndex((e) => e.tag === "0062_direct-chat-mode");
        assert.ok(cut > 0, "0062 is in the journal");
        journal.entries = journal.entries.slice(0, cut);
        writeFileSync(journalPath, JSON.stringify(journal));
        const old = drizzle(pool);
        await migrate(old, { migrationsFolder: before });

        const q = (text: string, values: unknown[] = []) => pool.query(text, values);
        const user = (await q(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`m-${randomUUID()}@example.com`])).rows[0].id;
        const company = (await q(`INSERT INTO companies (name, created_by_user_id) VALUES ('Old Co', $1) RETURNING id`, [user])).rows[0].id;
        const agent = (await q(`INSERT INTO agents (company_id, name) VALUES ($1, 'Old Agent') RETURNING id`, [company])).rows[0].id;
        const thread = (await q(`INSERT INTO message_threads (company_id, type, title) VALUES ($1, 'direct', 'Direct Agent Thread') RETURNING id`, [company])).rows[0].id;
        await q(`INSERT INTO thread_participants (thread_id, company_id, participant_type, participant_id) VALUES ($1, $2, 'agent', $3)`, [thread, company, agent]);

        await migrate(old, { migrationsFolder: migrations });

        assert.equal((await q(`SELECT direct_chat_mode FROM companies WHERE id = $1`, [company])).rows[0].direct_chat_mode, "shared");
        const migrated = (await q(`SELECT direct_agent_id, owner_user_id FROM message_threads WHERE id = $1`, [thread])).rows[0];
        assert.equal(migrated.direct_agent_id, agent);
        assert.equal(migrated.owner_user_id, null);
        const fresh = (await q(`INSERT INTO companies (name, created_by_user_id) VALUES ('New Co', $1) RETURNING direct_chat_mode`, [user])).rows[0];
        assert.equal(fresh.direct_chat_mode, "private");
    } finally {
        await pool.end();
        rmSync(before, { recursive: true, force: true });
        await db.execute(sql.raw(`DROP DATABASE IF EXISTS ${name}`));
    }
});
