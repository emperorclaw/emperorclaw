/**
 * Who may see, read and decide an approval, enforced on the server
 * (lib/approval-access.ts, lib/approval-routing.ts approvalView):
 *   - owners/admins, people granted "Can decide any approval", the requesting
 *     agent's owner and a routed ask's approvers decide; everyone else gets 403
 *     and a read-only card with the reason;
 *   - details (rationale, arguments, routing, note, who decided, task titles)
 *     only for those with a decide basis (or a member a routed ask waits on
 *     someone else for); the rest get the label;
 *   - a card in someone's private chat is 404 for people with no part in it;
 *   - the "Can decide any approval" list holds members only and is pruned
 *     when one leaves or is demoted;
 *   - the decision's audit records on what basis it was decided.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent } from "./_helper";
import { actAs, call, seedHuman } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function world() {
    await resetDb();
    const db = await getDb();
    const schema = await getSchema();
    const { eq, and } = await import("drizzle-orm");
    const [creator] = await db.insert(schema.users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [company] = await db.insert(schema.companies).values({ name: "Perms Co", createdByUserId: creator.id }).returning();
    const companyId = company.id;
    const owner = await seedHuman(companyId, "owner");
    const admin = await seedHuman(companyId, "admin");
    const agentOwner = await seedHuman(companyId, "member");
    const decider = await seedHuman(companyId, "member");
    const plain = await seedHuman(companyId, "member");
    const viewer = await seedHuman(companyId, "viewer");
    const agent = await seedAgent(companyId, { name: "Writer", ownerUserId: agentOwner.userId });
    const [project] = await db.insert(schema.projects).values({ companyId, goal: "Launch", status: "active" }).returning();
    /** An unrouted ask (approver_kind NULL: from before routing), with one task. */
    const newAsk = async (extra: Record<string, unknown> = {}) => {
        const [task] = await db.insert(schema.tasks).values({ companyId, projectId: project.id, taskType: "work", state: "review", assignedAgentId: agent.id, inputJson: { title: "Secret launch post" } }).returning();
        const [approval] = await db.insert(schema.approvals).values({ companyId, projectId: project.id, requesterAgentId: agent.id, actionType: "task_done", rationale: "Ready to ship", ...extra }).returning();
        await db.insert(schema.approvalTaskLinks).values({ companyId, approvalId: approval.id, taskId: task.id });
        return approval;
    };
    /** A private direct chat with the agent, owned by `who`. */
    const privateChat = async (who: { userId: string }) => (await db.insert(schema.messageThreads).values({
        companyId, type: "direct", directAgentId: agent.id, ownerUserId: who.userId, isPrivate: true, createdByType: "human",
    }).returning())[0];
    /** decidedAs in the approval's decision audit. */
    const decidedAs = async (approvalId: string) => {
        const rows = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.targetId, approvalId), eq(schema.auditLog.targetType, "approval")));
        const decision = rows.find((row) => row.action.startsWith("approval."));
        return (decision?.payloadJson as { meta?: Record<string, unknown> } | undefined)?.meta?.decidedAs;
    };
    const deciders = async () => {
        const [row] = await db.select({ settings: schema.companies.approvalSettingsJson }).from(schema.companies).where(eq(schema.companies.id, companyId));
        return ((row.settings as Record<string, unknown>).deciderUserIds ?? []) as string[];
    };
    return { companyId, owner, admin, agentOwner, decider, plain, viewer, agent, project, newAsk, privateChat, decidedAs, deciders, db, schema, eq };
}

type Who = { userId: string; sessionId: string };

async function as<T>(who: Who, fn: () => Promise<T>): Promise<T> {
    actAs(who);
    try { return await fn(); } finally { actAs(null); }
}

const route = () => import("@/app/api/approvals/[id]/route");
const patch = (who: Who, approvalId: string, status = "approved") => as(who, async () =>
    call((await route()).PATCH as never, `/api/approvals/${approvalId}`, { method: "PATCH", body: { status }, params: { id: approvalId } }));
const getDetail = (who: Who, approvalId: string) => as(who, async () =>
    call((await route()).GET as never, `/api/approvals/${approvalId}`, { params: { id: approvalId } }));
const list = (who: Who) => as(who, async () =>
    call((await import("@/app/api/approvals/route")).GET as never, "/api/approvals"));
const card = async (who: Who, approvalId: string) => {
    const res = await as(who, async () => call((await import("@/app/api/approvals/[id]/card/route")).GET as never, `/api/approvals/${approvalId}/card`, { params: { id: approvalId } }));
    return { status: res.status, card: (res.json?.card ?? {}) as Record<string, unknown> };
};
const putSettings = (who: Who, body: unknown) => as(who, async () =>
    call((await import("@/app/api/approval-settings/route")).PUT as never, "/api/approval-settings", { method: "PUT", body }));
const getSettings = (who: Who) => as(who, async () =>
    call((await import("@/app/api/approval-settings/route")).GET as never, "/api/approval-settings"));
const members = () => import("@/app/api/instance/members/[userId]/route");
const setRole = (who: Who, userId: string, role: string) => as(who, async () =>
    call((await members()).PUT as never, `/api/instance/members/${userId}`, { method: "PUT", body: { role }, params: { userId } }));
const removeMember = (who: Who, userId: string) => as(who, async () =>
    call((await members()).DELETE as never, `/api/instance/members/${userId}`, { method: "DELETE", params: { userId } }));

maybe("a plain member and a viewer get 403 on an unrouted ask; the card is read-only with the reason and no details", async () => {
    const w = await world();
    const ask = await w.newAsk();

    const refused = await patch(w.plain, ask.id);
    assert.equal(refused.status, 403);
    assert.equal(refused.json.reason, "not_permitted");
    assert.equal((await patch(w.viewer, ask.id)).json.reason, "viewer");

    const plainCard = await card(w.plain, ask.id);
    assert.equal(plainCard.status, 200);
    assert.equal(plainCard.card.mayDecide, false);
    assert.equal(plainCard.card.blockedReason, "not_permitted");
    assert.equal(plainCard.card.rationale, undefined);
    assert.equal(plainCard.card.tasks, undefined, "no task titles");
    assert.equal((await card(w.viewer, ask.id)).card.blockedReason, "viewer");

    const [row] = await w.db.select().from(w.schema.approvals).where(w.eq(w.schema.approvals.id, ask.id));
    assert.equal(row.status, "pending", "nothing was decided");
});

maybe("GET /api/approvals/[id] and the list redact the details for people who may not read them", async () => {
    const w = await world();
    const ask = await w.newAsk({ metadataJson: { secret: "x" } });

    const forViewer = await getDetail(w.viewer, ask.id);
    assert.equal(forViewer.status, 200);
    const approval = forViewer.json.approval as Record<string, unknown>;
    assert.equal(approval.redacted, true);
    assert.equal(approval.rationale, undefined);
    assert.equal(approval.metadataJson, undefined);
    assert.equal(approval.approverChainJson, undefined);
    assert.deepEqual(Object.keys((forViewer.json.tasks as Record<string, unknown>[])[0]).sort(), ["id", "projectId"], "task ids only");

    const forOwner = await getDetail(w.agentOwner, ask.id);
    assert.equal((forOwner.json.approval as Record<string, unknown>).rationale, "Ready to ship");

    const viewerList = (await list(w.viewer)).json.approvals as Record<string, unknown>[];
    assert.equal(viewerList.length, 1);
    assert.equal(viewerList[0].rationale, undefined);
    assert.equal(viewerList[0].redacted, true);
    const adminList = (await list(w.admin)).json.approvals as Record<string, unknown>[];
    assert.equal(adminList[0].rationale, "Ready to ship");
});

maybe("the list hides a private-chat ask from a member with no part in it", async () => {
    const w = await world();
    const chat = await w.privateChat(w.plain);
    const ask = await w.newAsk({ threadId: chat.id });
    const other = await seedHuman(w.companyId, "member");
    const ids = async (who: Who) => ((await list(who)).json.approvals as { id: string }[]).map((a) => a.id);
    assert.deepEqual(await ids(other), []);
    assert.deepEqual(await ids(w.plain), [ask.id], "the chat's owner sees it");
    assert.deepEqual(await ids(w.agentOwner), [ask.id], "the agent's owner may decide it, so sees it");
});

maybe("the agent's owner decides its ask, even in another member's private chat; the audit records the basis", async () => {
    const w = await world();
    const chat = await w.privateChat(w.plain);
    const ask = await w.newAsk({ threadId: chat.id });
    const ownerCard = await card(w.agentOwner, ask.id);
    assert.equal(ownerCard.status, 200);
    assert.equal(ownerCard.card.mayDecide, true);
    assert.equal(ownerCard.card.blockedReason, null);

    const chatOwnerCard = await card(w.plain, ask.id);
    assert.equal(chatOwnerCard.status, 200, "the chat's owner sees it");
    assert.equal(chatOwnerCard.card.blockedReason, "not_permitted", "but reads it only");

    const other = await seedHuman(w.companyId, "member");
    assert.equal((await card(other, ask.id)).status, 404);
    assert.equal((await getDetail(other, ask.id)).status, 404);
    assert.equal((await patch(other, ask.id)).status, 404);

    assert.equal((await patch(w.agentOwner, ask.id)).status, 200);
    const [row] = await w.db.select().from(w.schema.approvals).where(w.eq(w.schema.approvals.id, ask.id));
    assert.equal(row.status, "approved");
    assert.equal(row.resolverUserId, w.agentOwner.userId, "who decided is stored");
    assert.equal(await w.decidedAs(ask.id), "agent_owner");
});

maybe("a decided unrouted ask: a plain member gets 403 (not the 409 with the row), and its card shows no details", async () => {
    const w = await world();
    const ask = await w.newAsk();
    assert.equal((await patch(w.admin, ask.id, "rejected")).status, 200);
    assert.equal(await w.decidedAs(ask.id), "admin");

    const late = await patch(w.plain, ask.id);
    assert.equal(late.status, 403);
    assert.equal(late.json.reason, "not_permitted");
    assert.equal(late.json.approval, undefined);
    assert.equal((await patch(w.agentOwner, ask.id)).status, 409, "someone who could have decided learns who did");

    const decidedCard = await card(w.plain, ask.id);
    assert.equal(decidedCard.card.status, "rejected");
    assert.equal(decidedCard.card.resolverName, undefined);
    assert.equal(decidedCard.card.resolutionNote, undefined);
    assert.equal(decidedCard.card.rationale, undefined);
});

maybe("a granted decider decides once granted; the grant is per person", async () => {
    const w = await world();
    const ask = await w.newAsk();
    assert.equal((await patch(w.decider, ask.id)).status, 403, "not granted yet");
    const saved = await putSettings(w.owner, { deciderUserIds: [w.decider.userId] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.deciderUserIds, [w.decider.userId]);
    assert.equal((await patch(w.decider, ask.id)).status, 200);
    assert.equal(await w.decidedAs(ask.id), "decider");
    assert.equal((await patch(w.plain, (await w.newAsk()).id)).status, 403);
});

maybe("a routed ask: its approver decides; an unrelated member waits (and reads it); the agent owner overrides", async () => {
    const w = await world();
    const routed = { approverKind: "users", approverUserIds: [w.plain.userId], approverChainJson: [{ kind: "users", userIds: [w.plain.userId], source: "org_chart" }, { kind: "admins", source: "fallback" }], escalationLevel: 0 };
    const ask = await w.newAsk(routed);
    const other = await seedHuman(w.companyId, "member");
    const waiting = await patch(other, ask.id);
    assert.equal(waiting.status, 403);
    assert.equal(waiting.json.reason, "waiting_on_other");
    const otherCard = await card(other, ask.id);
    assert.equal(otherCard.card.blockedReason, "waiting_on_other");
    assert.equal(otherCard.card.rationale, "Ready to ship", "a member who could act still reads its reason, as before");
    assert.equal((await patch(w.plain, ask.id)).status, 200);
    assert.equal(await w.decidedAs(ask.id), "approver");

    const second = await w.newAsk(routed);
    assert.equal((await patch(w.agentOwner, second.id)).status, 200, "the agent's owner overrides routing");
});

maybe("an agent's owner demoted to viewer can no longer decide", async () => {
    const w = await world();
    const ask = await w.newAsk();
    assert.equal((await setRole(w.owner, w.agentOwner.userId, "viewer")).status, 200);
    const res = await patch(w.agentOwner, ask.id);
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "viewer");
    assert.equal((await card(w.agentOwner, ask.id)).card.blockedReason, "viewer");
});

maybe("a restricted member with only Can view on the project reads the card and cannot decide", async () => {
    const w = await world();
    const rita = await seedHuman(w.companyId, "member", { scope: { mode: "restricted", agentIds: [] } });
    await w.db.insert(w.schema.resourceMemberships).values({ companyId: w.companyId, userId: rita.userId, resourceType: "project", resourceId: w.project.id, role: "viewer" });
    await w.db.update(w.schema.agents).set({ ownerUserId: rita.userId }).where(w.eq(w.schema.agents.id, w.agent.id));
    const ask = await w.newAsk();
    const ritaCard = await card(rita, ask.id);
    assert.equal(ritaCard.status, 200);
    assert.equal(ritaCard.card.mayDecide, false);
    assert.equal(ritaCard.card.blockedReason, "view_only", "owning the agent does not beat Can view");
    const res = await patch(rita, ask.id);
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "view_only");
});

maybe("a decider who is removed or demoted is pruned from the list", async () => {
    const w = await world();
    const second = await seedHuman(w.companyId, "member");
    assert.equal((await putSettings(w.owner, { deciderUserIds: [w.decider.userId, second.userId] })).status, 200);

    assert.equal((await removeMember(w.owner, w.decider.userId)).status, 200);
    assert.deepEqual(await w.deciders(), [second.userId]);
    assert.equal((await setRole(w.owner, second.userId, "viewer")).status, 200);
    assert.deepEqual(await w.deciders(), []);

    // A stale id in the stored list (written before this rule) is never echoed back, so saving again works.
    await w.db.update(w.schema.companies).set({ approvalSettingsJson: { deciderUserIds: [randomUUID()] } }).where(w.eq(w.schema.companies.id, w.companyId));
    const shown = await getSettings(w.owner);
    assert.deepEqual(shown.json.deciderUserIds, []);
    assert.equal((await putSettings(w.owner, { deciderUserIds: shown.json.deciderUserIds })).status, 200);
});

maybe("only members (never owners, admins, viewers or outsiders) can be granted; only admins set it; the audit names who", async () => {
    const w = await world();
    assert.equal((await putSettings(w.owner, { deciderUserIds: [w.viewer.userId] })).status, 400);
    assert.equal((await putSettings(w.owner, { deciderUserIds: [w.admin.userId] })).status, 400, "admins always decide");
    assert.equal((await putSettings(w.owner, { deciderUserIds: [randomUUID()] })).status, 400);
    assert.equal((await putSettings(w.owner, { deciderUserIds: "nope" })).status, 400);
    assert.equal((await putSettings(w.plain, { deciderUserIds: [w.plain.userId] })).status, 403, "members can't grant themselves");
    const options = (await getSettings(w.owner)).json.deciderOptions as { id: string }[];
    assert.deepEqual(options.map((o) => o.id).sort(), [w.agentOwner.userId, w.decider.userId, w.plain.userId].sort(), "the picker offers members only");

    assert.equal((await putSettings(w.admin, { deciderUserIds: [w.decider.userId] })).status, 200);
    assert.equal((await putSettings(w.admin, { deciderUserIds: [] })).status, 200);
    const audits = await w.db.select().from(w.schema.auditLog).where(w.eq(w.schema.auditLog.action, "company.settings_changed"));
    const afters = audits.map((row) => (row.payloadJson as { after?: Record<string, unknown> }).after ?? {});
    assert.ok(afters.some((after) => JSON.stringify(after.decidersAdded) === JSON.stringify([w.decider.userId])));
    assert.ok(afters.some((after) => JSON.stringify(after.decidersRemoved) === JSON.stringify([w.decider.userId])));
});

maybe("implicit tasks (requires approval, no request yet): a plain member can't decide; the agent's owner can, through the API", async () => {
    const w = await world();
    const [task] = await w.db.insert(w.schema.tasks).values({ companyId: w.companyId, projectId: w.project.id, taskType: "work", state: "review", assignedAgentId: w.agent.id, humanApprovalRequired: true, inputJson: { title: "Flagged" } }).returning();
    const { implicitTaskReasons } = await import("@/lib/approval-access");
    const { requireRole } = await import("@/lib/roles");
    const reasonFor = async (who: Who) => as(who, async () => (await implicitTaskReasons(await requireRole("viewer")(), [task])).get(task.id));
    assert.equal(await reasonFor(w.plain), "not_permitted");
    assert.equal(await reasonFor(w.agentOwner), null);
    assert.equal(await reasonFor(w.viewer), "viewer");

    const count = async (who: Who) => (await as(who, async () => call((await import("@/app/api/approvals/pending-count/route")).GET as never, "/api/approvals/pending-count"))).json.count;
    assert.equal(await count(w.plain), 0);
    assert.equal(await count(w.agentOwner), 1);

    // The Approvals page creates the ask (POST) then decides it: the agent's owner may.
    const created = await as(w.agentOwner, async () => call((await import("@/app/api/approvals/route")).POST as never, "/api/approvals", { method: "POST", body: { projectId: w.project.id, taskIds: [task.id] } }));
    assert.equal(created.status, 201);
    const approvalId = (created.json.approval as { id: string }).id;
    assert.equal((await patch(w.plain, approvalId)).json.reason, "not_permitted");
    assert.equal((await patch(w.agentOwner, approvalId)).status, 200);
});

maybe("the task story: a viewer gets status only (no rationale, note or decider); a private-chat ask is absent for a member with no part in it", async () => {
    const w = await world();
    const ask = await w.newAsk();
    assert.equal((await patch(w.agentOwner, ask.id, "rejected")).status, 200);
    const [link] = await w.db.select().from(w.schema.approvalTaskLinks).where(w.eq(w.schema.approvalTaskLinks.approvalId, ask.id));
    const chat = await w.privateChat(w.agentOwner);
    const hidden = await w.newAsk({ threadId: chat.id });
    await w.db.insert(w.schema.approvalTaskLinks).values({ companyId: w.companyId, approvalId: hidden.id, taskId: link.taskId });

    const { loadTaskStory, loadTaskViewer } = await import("@/lib/task-story-reads");
    const story = async (who: { userId: string }) => (await loadTaskStory(w.companyId, link.taskId, await loadTaskViewer(w.companyId, who.userId)))!;
    type Entry = { kind: string; approvalId?: string; note?: string | null; resolverName?: string | null };
    const approvalEntries = async (who: { userId: string }) => ((await story(who)).entries as Entry[]).filter((e) => e.kind === "approval");

    const forViewer = await approvalEntries(w.viewer);
    assert.ok(forViewer.some((e) => e.approvalId === ask.id), "the viewer sees that it happened");
    assert.ok(forViewer.every((e) => e.note === null && e.resolverName === null), "but no rationale, note or decider");
    assert.ok(!forViewer.some((e) => e.approvalId === hidden.id), "nor the private-chat ask");
    assert.equal((await story(w.viewer)).task.approval.latest?.resolverName ?? null, null);

    const forPlain = await approvalEntries(w.plain);
    assert.ok(!forPlain.some((e) => e.approvalId === hidden.id), "a member with no part in the private chat");

    const forOwner = await approvalEntries(w.agentOwner);
    assert.ok(forOwner.some((e) => e.approvalId === hidden.id), "the agent's owner may decide it, so sees it");
    assert.ok(forOwner.some((e) => e.approvalId === ask.id && e.note === "Ready to ship"), "and reads the details");
});

maybe("POST /api/approvals rejects a task from another project, a deleted task and repeated ids", async () => {
    const w = await world();
    const [other] = await w.db.insert(w.schema.projects).values({ companyId: w.companyId, goal: "Other", status: "active" }).returning();
    const [foreign] = await w.db.insert(w.schema.tasks).values({ companyId: w.companyId, projectId: other.id, taskType: "work", state: "review", assignedAgentId: w.agent.id, humanApprovalRequired: true, inputJson: { title: "Elsewhere" } }).returning();
    const [deleted] = await w.db.insert(w.schema.tasks).values({ companyId: w.companyId, projectId: w.project.id, taskType: "work", state: "review", deletedAt: new Date(), inputJson: { title: "Gone" } }).returning();
    const [mine] = await w.db.insert(w.schema.tasks).values({ companyId: w.companyId, projectId: w.project.id, taskType: "work", state: "review", inputJson: { title: "Here" } }).returning();
    const post = (taskIds: unknown[]) => as(w.owner, async () => call((await import("@/app/api/approvals/route")).POST as never, "/api/approvals", { method: "POST", body: { projectId: w.project.id, taskIds } }));
    assert.equal((await post([foreign.id])).status, 404);
    assert.equal((await post([mine.id, foreign.id])).status, 404, "one stray task rejects the whole ask");
    assert.equal((await post([deleted.id])).status, 404);
    assert.equal((await post([mine.id, mine.id])).status, 400);
    assert.equal((await post(["not-a-uuid"])).status, 400);
    const [count] = await w.db.select({ n: (await import("drizzle-orm")).count() }).from(w.schema.approvals);
    assert.equal(Number(count.n), 0, "nothing was created");
    assert.equal((await post([mine.id])).status, 201);
});

maybe("the work timeline and the live feed: private-chat asks stay out, and nobody without the right is named", async () => {
    const w = await world();
    const chat = await w.privateChat(w.agentOwner);
    const open = await w.newAsk({ requestedAt: new Date(Date.now() - 60_000) });
    const hidden = await w.newAsk({ threadId: chat.id, requestedAt: new Date(Date.now() - 60_000) });
    assert.equal((await patch(w.admin, open.id, "approved")).status, 200);

    const { loadWorkTimeline } = await import("@/lib/work-timeline-reads");
    const { loadTaskViewer } = await import("@/lib/task-story-reads");
    const timeline = async (who: { userId: string }) => loadWorkTimeline(w.companyId, await loadTaskViewer(w.companyId, who.userId), { fromMs: Date.now() - 3_600_000, toMs: Date.now() + 60_000 });
    const plainEvents = (await timeline(w.plain)).events;
    assert.ok(plainEvents.some((e) => e.id === `apr:${open.id}`), "harness: the open ask is drawn");
    assert.ok(!plainEvents.some((e) => e.id.endsWith(hidden.id)), "not the private-chat ask");
    const decided = plainEvents.find((e) => e.id === `apd:${open.id}`);
    assert.ok(decided, "the decision is drawn");
    assert.equal(decided!.byName, null, "but who decided is not named to a member with no basis");
    const adminDecided = (await timeline(w.admin)).events.find((e) => e.id === `apd:${open.id}`);
    assert.ok(adminDecided?.byName, "an admin sees who decided");

    // Live feed (screens): a pending action ask with no task, so the title would carry the rationale.
    const [secretAsk] = await w.db.insert(w.schema.approvals).values({ companyId: w.companyId, requesterAgentId: w.agent.id, actionType: "spend_money", rationale: "Secret budget line", threadId: chat.id }).returning();
    const [publicAsk] = await w.db.insert(w.schema.approvals).values({ companyId: w.companyId, requesterAgentId: w.agent.id, actionType: "publish", rationale: "Visible launch note" }).returning();
    const { buildLiveFeed } = await import("@/lib/live-feed");
    const titles = (feed: Awaited<ReturnType<typeof buildLiveFeed>>) => JSON.stringify([feed.needs, feed.events, feed.agents.map((a) => (a as { approval?: unknown }).approval)]);
    const unscoped = titles(await buildLiveFeed(w.companyId, {}));
    assert.ok(unscoped.includes("Visible launch note"), "harness: the unscoped feed shows a normal ask's rationale");
    assert.ok(!unscoped.includes("Secret budget"), "no private-chat rationale, even unscoped");
    const scoped = titles(await buildLiveFeed(w.companyId, { scopedApprovals: true }));
    assert.ok(!scoped.includes("Visible launch note"), "a scoped screen never shows a rationale");
    assert.ok(!scoped.includes(secretAsk.id), "nor a private-chat ask");
    assert.ok(publicAsk.id);
});
