import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, call, seedHuman } from "./_access-helper";

/**
 * Several private chats per (person, agent) (docs/design/multi-chat-per-agent.md, P0):
 * one main chat per person and agent, extra chats created with their first
 * message, the open-chat cap, archive/restore, the company settings, privacy
 * (owner only) and the audit trail.
 */
const maybe = dbAvailable ? test : test.skip;

type Person = { userId: string; sessionId: string };

async function seed(options: { maxOpen?: number } = {}) {
    await resetDb();
    const db = await getDb();
    const { companies } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { companyId } = await seedCompanyWithToken();
    const owner = await seedHuman(companyId, "owner");
    const member = await seedHuman(companyId, "member");
    const admin = await seedHuman(companyId, "admin");
    const viewer = await seedHuman(companyId, "viewer");
    await db.update(companies).set({ directChatMode: "private", ...(options.maxOpen ? { multiChatMaxOpen: options.maxOpen } : {}) })
        .where(eq(companies.id, companyId));
    const agent = await seedAgent(companyId, { name: "Scout", provider: "hermes" });
    return { companyId, owner, member, admin, viewer, agent };
}

async function newChat(person: Person, agentId: string, text: string, clientKey = `key-${randomUUID()}`) {
    const { POST } = await import("@/app/api/chat/route");
    actAs(person);
    return call(POST, "/api/chat", { method: "POST", body: { text, targetAgentId: agentId, newChat: { clientKey } } });
}

async function patchChat(person: Person, threadId: string, body: Record<string, unknown>) {
    const { PATCH } = await import("@/app/api/chat/threads/[id]/route");
    actAs(person);
    return call(PATCH, `/api/chat/threads/${threadId}`, { method: "PATCH", body, params: { id: threadId } });
}

async function listChats(person: Person, agentId: string, archived = false) {
    const { GET } = await import("@/app/api/chat/threads/route");
    actAs(person);
    return call(GET, `/api/chat/threads?agentId=${agentId}${archived ? "&archived=1" : ""}`);
}

async function postIn(person: Person, agentId: string, threadId: string, text: string) {
    const { POST } = await import("@/app/api/chat/route");
    actAs(person);
    return call(POST, "/api/chat", { method: "POST", body: { text, targetAgentId: agentId, directThreadId: threadId } });
}

async function readIn(person: Person, agentId: string, threadId: string) {
    const { GET } = await import("@/app/api/chat/route");
    actAs(person);
    return call(GET, `/api/chat?targetAgentId=${agentId}&directThreadId=${threadId}`);
}

async function liveChats(companyId: string, userId: string, agentId: string) {
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const { and, eq, isNull } = await import("drizzle-orm");
    return db.select().from(messageThreads).where(and(
        eq(messageThreads.companyId, companyId), eq(messageThreads.ownerUserId, userId),
        eq(messageThreads.directAgentId, agentId), isNull(messageThreads.archivedAt),
    ));
}

async function audits(companyId: string, action: string) {
    const db = await getDb();
    const { auditLog } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    return db.select().from(auditLog).where(and(eq(auditLog.companyId, companyId), eq(auditLog.action, action)));
}

maybe("the main chat stays unique and is what every caller without a thread id gets, under concurrency", async () => {
    const s = await seed();
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const { createPrivateChat } = await import("@/lib/private-chats");
    const results = await Promise.all([
        ...Array.from({ length: 6 }, () => ensureDirectThread(s.companyId, s.agent.id, s.owner.userId).then((t) => ({ main: true, id: t.id }))),
        ...Array.from({ length: 4 }, (_, i) => createPrivateChat({ companyId: s.companyId, userId: s.owner.userId, agentId: s.agent.id, firstMessage: `topic ${i}`, clientKey: `concurrent-${i}-${randomUUID()}` })
            .then((r) => ({ main: false, id: r.thread.id }))),
    ]);
    const mains = new Set(results.filter((r) => r.main).map((r) => r.id));
    assert.equal(mains.size, 1, "every get-or-create returned the same main chat");
    const live = await liveChats(s.companyId, s.owner.userId, s.agent.id);
    assert.equal(live.length, 5);
    assert.deepEqual(live.filter((t) => t.isMain).map((t) => t.id), [...mains]);
    assert.ok(live.filter((t) => !t.isMain).every((t) => t.title?.startsWith("topic ")), "extra chats are titled from the first message");
    assert.equal((await ensureDirectThread(s.companyId, s.agent.id, s.owner.userId)).id, [...mains][0]);
});

maybe("the open-chat cap holds under concurrent creates and answers 409 with the numbers", async () => {
    const s = await seed({ maxOpen: 3 });
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const { createPrivateChat, PrivateChatError } = await import("@/lib/private-chats");
    await ensureDirectThread(s.companyId, s.agent.id, s.owner.userId);
    const settled = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
        createPrivateChat({ companyId: s.companyId, userId: s.owner.userId, agentId: s.agent.id, firstMessage: `q${i}`, clientKey: `cap-${i}-${randomUUID()}` })));
    assert.equal(settled.filter((r) => r.status === "fulfilled").length, 2, "main + 2 extra = the cap of 3");
    for (const r of settled.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
        assert.ok(r.reason instanceof PrivateChatError);
        assert.equal(r.reason.status, 409);
        assert.deepEqual(r.reason.body(), { error: r.reason.message, code: "chat_limit_reached", limit: 3, open: 3 });
    }
    assert.equal((await liveChats(s.companyId, s.owner.userId, s.agent.id)).length, 3);

    const res = await newChat(s.owner, s.agent.id, "one more");
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "chat_limit_reached");
    // Another person's cap is their own.
    assert.equal((await newChat(s.member, s.agent.id, "my first extra")).status, 200);
});

maybe("POST /api/chat newChat: creates the chat with the first message, idempotent on clientKey", async () => {
    const s = await seed();
    const first = await newChat(s.owner, s.agent.id, "  Draft the   Q3 investor update  ", "client-key-0001");
    assert.equal(first.status, 200, first.text);
    const thread = first.json.thread as { id: string; isMain: boolean; title: string; ownerUserId: string };
    assert.equal(first.json.created, true);
    assert.equal(thread.isMain, false);
    assert.equal(thread.title, "Draft the Q3 investor update");
    assert.equal(thread.ownerUserId, s.owner.userId);

    const again = await newChat(s.owner, s.agent.id, "  Draft the   Q3 investor update  ", "client-key-0001");
    assert.equal(again.status, 200, again.text);
    assert.equal((again.json.thread as { id: string }).id, thread.id, "the same key returns the same chat");
    assert.equal(again.json.deduplicated, true);
    assert.equal((again.json.message as { id: string }).id, (first.json.message as { id: string }).id);

    const db = await getDb();
    const { threadMessages, threadParticipants } = await getSchema();
    const { eq } = await import("drizzle-orm");
    assert.equal((await db.select().from(threadMessages).where(eq(threadMessages.threadId, thread.id))).length, 1, "one message, not two");
    const humans = (await db.select().from(threadParticipants).where(eq(threadParticipants.threadId, thread.id)))
        .filter((p) => p.participantType === "human").map((p) => p.participantRef);
    assert.deepEqual(humans, [s.owner.userId], "the owner is the only human participant");

    const other = await newChat(s.owner, s.agent.id, "Something else", "client-key-0002");
    assert.notEqual((other.json.thread as { id: string }).id, thread.id, "a new key is a new chat");

    // Audit: ids and the agent's name, never the title.
    const created = await audits(s.companyId, "thread.created");
    assert.equal(created.length, 2);
    const row = created.find((r) => r.targetId === thread.id)!;
    assert.equal(row.targetType, "thread");
    assert.equal(row.actorId, s.owner.userId);
    assert.ok(!JSON.stringify(row.payloadJson).includes("investor"), "the title is never audited");
    assert.deepEqual(row.payloadJson, { meta: { agentId: s.agent.id, label: "Scout" } });
});

maybe("newChat refusals: viewers, commands, bad keys, and the per-person rate limit", async () => {
    const s = await seed();
    assert.equal((await newChat(s.viewer, s.agent.id, "hi")).status, 403, "viewers never post");
    assert.equal((await newChat(s.owner, s.agent.id, "/goal ship it")).status, 400);
    assert.equal((await newChat(s.owner, s.agent.id, "hi", "bad key")).status, 400);
    const { companies } = await getSchema();
    const db = await getDb();
    const { eq } = await import("drizzle-orm");
    await db.update(companies).set({ multiChatMaxOpen: 50 }).where(eq(companies.id, s.companyId));
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await newChat(s.member, s.agent.id, `burst ${i}`)).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
    assert.equal(statuses[10], 429, "10 new chats a minute per person");
});

maybe("privacy: another person and an admin get 404 on a chat they do not own", async () => {
    const s = await seed();
    const created = await newChat(s.owner, s.agent.id, "owner's private topic");
    const threadId = (created.json.thread as { id: string }).id;
    for (const intruder of [s.member, s.admin]) {
        assert.equal((await readIn(intruder, s.agent.id, threadId)).status, 404);
        assert.equal((await postIn(intruder, s.agent.id, threadId, "let me in")).status, 404);
        assert.equal((await patchChat(intruder, threadId, { title: "mine now" })).status, 404);
        assert.equal((await patchChat(intruder, threadId, { archived: true })).status, 404);
        const list = await listChats(intruder, s.agent.id);
        assert.equal(list.status, 200);
        assert.ok(!(list.json.chats as { id: string }[]).some((c) => c.id === threadId), "never listed for anyone else");
    }
    const mine = await listChats(s.owner, s.agent.id);
    const mineChats = mine.json.chats as { id: string; isMain: boolean }[];
    assert.deepEqual(mineChats.map((c) => c.isMain), [true, false], "the main chat is created with the first extra one");
    assert.equal(mineChats[1].id, threadId);
    assert.equal((await readIn(s.owner, s.agent.id, threadId)).status, 200);
});

maybe("sealing the agent away from a person hides their chats with it", async () => {
    const s = await seed();
    const created = await newChat(s.member, s.agent.id, "member topic");
    const threadId = (created.json.thread as { id: string }).id;
    const db = await getDb();
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    // Limited to its owner (another person): the member may no longer use it.
    await db.update(agents).set({ access: "owner", ownerUserId: s.owner.userId }).where(eq(agents.id, s.agent.id));
    assert.equal((await listChats(s.member, s.agent.id)).status, 404);
    assert.equal((await patchChat(s.member, threadId, { title: "x" })).status, 404);
    assert.equal((await newChat(s.member, s.agent.id, "another")).status, 404);
});

maybe("settings: admin only, validated, audited; off blocks new chats and restores, not existing ones", async () => {
    const s = await seed();
    const route = await import("@/app/api/settings/direct-chats/route");
    const { makeRequest } = await import("./_helper");
    const put = async (person: Person, body: unknown) => {
        actAs(person);
        const res = await route.PUT(makeRequest("http://localhost/api/settings/direct-chats", { method: "PUT", body }));
        return { status: res.status, json: await res.json() as Record<string, unknown> };
    };
    actAs(s.member);
    const read = await (await route.GET()).json() as Record<string, unknown>;
    assert.deepEqual(read, { mode: "private", multiChatEnabled: true, multiChatMaxOpen: 20, multiChatIdleArchiveDays: 30 });

    assert.equal((await put(s.member, { multiChatEnabled: false })).status, 403);
    assert.equal((await put(s.admin, { multiChatMaxOpen: 0 })).status, 400);
    assert.equal((await put(s.admin, { multiChatMaxOpen: 51 })).status, 400);
    assert.equal((await put(s.admin, { multiChatIdleArchiveDays: 3 })).status, 400);
    assert.equal((await put(s.admin, { mode: "private" })).status, 200, "the old body still works");
    const ok = await put(s.admin, { multiChatIdleArchiveDays: null, multiChatMaxOpen: 5 });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.multiChatIdleArchiveDays, null);

    const extra = await newChat(s.owner, s.agent.id, "before the switch");
    const extraId = (extra.json.thread as { id: string }).id;
    assert.equal((await put(s.admin, { multiChatEnabled: false })).status, 200);

    const refused = await newChat(s.owner, s.agent.id, "after the switch");
    assert.equal(refused.status, 403);
    assert.equal(refused.json.code, "multi_chat_disabled");
    assert.equal((await postIn(s.owner, s.agent.id, extraId, "still usable")).status, 200, "existing extra chats stay usable");
    assert.equal((await patchChat(s.owner, extraId, { archived: true })).status, 200, "and can be archived");
    const restore = await patchChat(s.owner, extraId, { archived: false });
    assert.equal(restore.status, 403, "restore is refused while the setting is off");
    assert.equal(restore.json.code, "multi_chat_disabled");

    const changes = (await audits(s.companyId, "company.settings_changed"))
        .filter((r) => (r.payloadJson as { meta?: { setting?: string } }).meta?.setting === "multiChat");
    assert.equal(changes.length, 2);
    assert.deepEqual((changes.find((r) => (r.payloadJson as { after: { multiChatEnabled: boolean } }).after.multiChatEnabled === false)!.payloadJson as { before: unknown }).before,
        { multiChatEnabled: true, multiChatMaxOpen: 5, multiChatIdleArchiveDays: null });

    // Shared mode: no new chats either.
    await put(s.admin, { multiChatEnabled: true, mode: "shared" });
    assert.equal((await newChat(s.owner, s.agent.id, "shared mode")).json.code, "multi_chat_disabled");
});

maybe("archive and restore: main is permanent, archived chats are read-only, restore respects the cap and the main", async () => {
    const s = await seed({ maxOpen: 3 });
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const main = await ensureDirectThread(s.companyId, s.agent.id, s.owner.userId);

    const archiveMain = await patchChat(s.owner, main.id, { archived: true });
    assert.equal(archiveMain.status, 409);
    assert.equal(archiveMain.json.code, "main_chat_cannot_be_archived");
    assert.equal((await patchChat(s.owner, main.id, { title: "Renamed main" })).json.code, "main_chat_cannot_be_renamed");

    const a = (await newChat(s.owner, s.agent.id, "chat a")).json.thread as { id: string };
    const b = (await newChat(s.owner, s.agent.id, "chat b")).json.thread as { id: string };
    const renamed = await patchChat(s.owner, a.id, { title: "  Budget   review " });
    assert.equal(renamed.status, 200);
    assert.equal((renamed.json.thread as { title: string }).title, "Budget review");
    assert.equal((await patchChat(s.owner, a.id, { title: "" })).status, 400);
    assert.equal((await patchChat(s.owner, a.id, { title: "x", archived: true })).status, 400);

    const archived = await patchChat(s.owner, a.id, { archived: true });
    assert.equal(archived.status, 200);
    assert.equal((archived.json.thread as { archiveReason: string }).archiveReason, "manual");
    const send = await postIn(s.owner, s.agent.id, a.id, "hello?");
    assert.equal(send.status, 409);
    assert.equal(send.json.code, "chat_archived");
    assert.equal((await readIn(s.owner, s.agent.id, a.id)).status, 200, "an archived chat stays readable");
    assert.equal((await patchChat(s.owner, a.id, { title: "nope" })).json.code, "chat_archived");
    const archivedList = await listChats(s.owner, s.agent.id, true);
    assert.deepEqual((archivedList.json.chats as { id: string; archiveReason: string }[]).map((c) => [c.id, c.archiveReason]), [[a.id, "manual"]]);
    assert.equal(archivedList.json.open, 2);

    // Back at the cap (main + b + c): restoring a is refused.
    await newChat(s.owner, s.agent.id, "chat c");
    const full = await patchChat(s.owner, a.id, { archived: false });
    assert.equal(full.status, 409);
    assert.deepEqual([full.json.code, full.json.limit, full.json.open], ["chat_limit_reached", 3, 3]);
    await patchChat(s.owner, b.id, { archived: true });
    const restored = await patchChat(s.owner, a.id, { archived: false });
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.json.thread, { id: a.id, title: "Budget review", isMain: false, archivedAt: null, archiveReason: null });

    // A former main chat comes back as a normal chat while another main is live,
    // and as the main chat when there is none.
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(messageThreads).set({ archivedAt: new Date(), archiveReason: "member_left" }).where(eq(messageThreads.id, main.id));
    const newMain = await ensureDirectThread(s.companyId, s.agent.id, s.owner.userId);
    assert.notEqual(newMain.id, main.id);
    assert.equal(newMain.isMain, true);
    await patchChat(s.owner, a.id, { archived: true });
    const back = await patchChat(s.owner, main.id, { archived: false });
    assert.equal(back.status, 200, back.text);
    assert.equal((back.json.thread as { isMain: boolean }).isMain, false, "only one live main");

    await patchChat(s.owner, main.id, { archived: true });
    await db.update(messageThreads).set({ archivedAt: new Date() }).where(eq(messageThreads.id, newMain.id));
    const asMain = await patchChat(s.owner, newMain.id, { archived: false });
    assert.equal((asMain.json.thread as { isMain: boolean }).isMain, true, "no live main: it is the main again");

    const events = (await audits(s.companyId, "thread.archived")).map((r) => (r.payloadJson as { meta: { reason: string } }).meta.reason);
    assert.ok(events.length >= 3 && events.every((r) => r === "manual"));
    assert.ok((await audits(s.companyId, "thread.restored")).length >= 3);
});

maybe("the chat list: main first, then by activity, with unread, running and queued", async () => {
    const s = await seed();
    const { ensureDirectThread, appendThreadMessage } = await import("@/lib/control-plane");
    const main = await ensureDirectThread(s.companyId, s.agent.id, s.owner.userId);
    const older = (await newChat(s.owner, s.agent.id, "older topic")).json.thread as { id: string };
    const newer = (await newChat(s.owner, s.agent.id, "newer topic")).json.thread as { id: string };
    await appendThreadMessage({ companyId: s.companyId, threadId: newer.id, senderType: "agent", senderId: s.agent.id, text: "answer" });
    const res = await listChats(s.owner, s.agent.id);
    assert.equal(res.status, 200);
    const chats = res.json.chats as { id: string; isMain: boolean; unread: number; queued: number; running: boolean; lastMessageAt: string | null }[];
    assert.deepEqual(chats.map((c) => c.id), [main.id, newer.id, older.id]);
    assert.equal(chats[0].isMain, true);
    assert.equal(chats[1].unread, 1);
    assert.equal(chats[2].queued, 1, "its first message waits for the agent");
    assert.equal(res.json.open, 3);
    assert.equal(res.json.limit, 20);
    assert.equal(res.json.multiChatEnabled, true);
});

maybe("a member who leaves: all of their chats are archived with reason member_left", async () => {
    const s = await seed();
    const { ensureDirectThread, archivePrivateThreadsOf } = await import("@/lib/control-plane");
    await ensureDirectThread(s.companyId, s.agent.id, s.member.userId);
    await newChat(s.member, s.agent.id, "extra one");
    await archivePrivateThreadsOf(s.companyId, s.member.userId);
    assert.equal((await liveChats(s.companyId, s.member.userId, s.agent.id)).length, 0);
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(messageThreads).where(eq(messageThreads.ownerUserId, s.member.userId));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.archivedAt && r.archiveReason === "member_left"));
});

maybe("deleting the agent deletes every chat with it and audits the count, never the contents", async () => {
    const s = await seed();
    const { ensureDirectThread } = await import("@/lib/control-plane");
    await ensureDirectThread(s.companyId, s.agent.id, s.owner.userId);
    await newChat(s.owner, s.agent.id, "topic one");
    await newChat(s.member, s.agent.id, "topic two");
    const { deleteAgentAndData } = await import("@/lib/agent-deletion");
    await deleteAgentAndData({ companyId: s.companyId, agentId: s.agent.id, actorType: "human", actorId: s.owner.userId });
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const { eq } = await import("drizzle-orm");
    assert.equal((await db.select().from(messageThreads).where(eq(messageThreads.directAgentId, s.agent.id))).length, 0);
    const [row] = await audits(s.companyId, "agent.deleted");
    // The owner's main + extra, and the member's extra plus the main chat created with it.
    assert.equal((row.payloadJson as { meta: { deletedThreadCount: number } }).meta.deletedThreadCount, 4);
    assert.ok(!JSON.stringify(row.payloadJson).includes("topic"));
});

maybe("no second chat: the Messages listing is unchanged, and goes back to it once the extra chat is archived", async () => {
    const s = await seed();
    const { ensureDirectThread, ensureTeamThread, appendThreadMessage } = await import("@/lib/control-plane");
    const { loadMessagesListing } = await import("@/lib/messages-listing");
    const main = await ensureDirectThread(s.companyId, s.agent.id, s.owner.userId);
    await ensureDirectThread(s.companyId, s.agent.id, null);
    const team = await ensureTeamThread(s.companyId);
    await appendThreadMessage({ companyId: s.companyId, threadId: main.id, senderType: "agent", senderId: s.agent.id, text: "hello" });
    const viewer = { companyId: s.companyId, userId: s.owner.userId, role: "owner" as const, scope: null };

    const before = await loadMessagesListing(viewer);
    assert.equal("extraChats" in before, false, "no extraChats key at all");
    assert.deepEqual(before.listedThreadIds, [main.id, team.id]);
    assert.deepEqual(before.direct.map((d) => [d.kind, d.thread.id === main.id]), [["primary", true], ["operations", false]]);
    const snapshot = JSON.stringify(before);

    // Another person's extra chats change nothing for this person.
    await newChat(s.member, s.agent.id, "member's own topic");
    assert.equal(JSON.stringify(await loadMessagesListing(viewer)), snapshot);

    // Their own extra chat is listed alongside the main chat (which stays primary)...
    const extra = (await newChat(s.owner, s.agent.id, "a newer topic")).json.thread as { id: string };
    await appendThreadMessage({ companyId: s.companyId, threadId: extra.id, senderType: "agent", senderId: s.agent.id, text: "newer than main" });
    const withExtra = await loadMessagesListing(viewer);
    assert.equal(withExtra.direct.find((d) => d.kind === "primary")!.thread.id, main.id, "the main chat, not the most recent one");
    assert.deepEqual(withExtra.extraChats!.map((d) => d.thread.id), [extra.id]);
    assert.deepEqual(withExtra.listedThreadIds, [main.id, team.id, extra.id]);

    // ...and once archived, the listing is byte-identical to before.
    await patchChat(s.owner, extra.id, { archived: true });
    assert.equal(JSON.stringify(await loadMessagesListing(viewer)), snapshot);
});

maybe("migration 0082 backfill: one live main per person and agent, archived ones kept as former mains", async () => {
    const s = await seed();
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const { eq, sql } = await import("drizzle-orm");
    const base = { companyId: s.companyId, type: "direct", directAgentId: s.agent.id, isPrivate: true, isMain: false };
    const [oldArchived] = await db.insert(messageThreads).values({ ...base, ownerUserId: s.owner.userId, archivedAt: new Date("2026-01-01"), createdAt: new Date("2025-01-01") }).returning();
    const [live] = await db.insert(messageThreads).values({ ...base, ownerUserId: s.owner.userId, createdAt: new Date("2026-02-01") }).returning();
    // A stray second live private thread (the old unique index would have refused it): the oldest live one wins.
    const [stray] = await db.insert(messageThreads).values({ ...base, ownerUserId: s.owner.userId, createdAt: new Date("2026-03-01") }).returning();
    const [shared] = await db.insert(messageThreads).values({ companyId: s.companyId, type: "direct", directAgentId: s.agent.id }).returning();

    const migration = readFileSync(path.join(process.cwd(), "src/db/migrations/0082_multi-chat.sql"), "utf8");
    const updates = migration.split("--> statement-breakpoint").map((part) => part.trim()).filter((part) => part.startsWith("UPDATE"));
    assert.equal(updates.length, 2);
    for (const statement of updates) await db.execute(sql.raw(statement));

    const isMain = async (id: string) => (await db.select({ isMain: messageThreads.isMain }).from(messageThreads).where(eq(messageThreads.id, id)))[0].isMain;
    assert.equal(await isMain(live.id), true);
    assert.equal(await isMain(stray.id), false);
    assert.equal(await isMain(oldArchived.id), true);
    assert.equal(await isMain(shared.id), false, "shared/Operations threads are never a main chat");
});

/* ---------- Review fixes ---------- */

async function extraThreadsAndMessages(companyId: string, userId: string, agentId: string) {
    const db = await getDb();
    const { messageThreads, threadMessages } = await getSchema();
    const { and, eq, inArray } = await import("drizzle-orm");
    const threads = await db.select().from(messageThreads).where(and(
        eq(messageThreads.companyId, companyId), eq(messageThreads.ownerUserId, userId), eq(messageThreads.directAgentId, agentId), eq(messageThreads.isMain, false),
    ));
    const messages = threads.length ? await db.select().from(threadMessages).where(inArray(threadMessages.threadId, threads.map((t) => t.id))) : [];
    return { threads, messages };
}

maybe("concurrent new-chat requests with one clientKey make one chat with exactly one first message", async () => {
    const s = await seed();
    const key = `same-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => newChat(s.owner, s.agent.id, "only once", key)));
    for (const r of results) assert.equal(r.status, 200, r.text);
    assert.equal(results.filter((r) => r.json.created === true).length, 1, "one creation, the rest are replays");
    assert.equal(new Set(results.map((r) => (r.json.thread as { id: string }).id)).size, 1);
    assert.equal(new Set(results.map((r) => (r.json.message as { id: string }).id)).size, 1);
    const { threads, messages } = await extraThreadsAndMessages(s.companyId, s.owner.userId, s.agent.id);
    assert.equal(threads.length, 1);
    assert.equal(messages.length, 1, "the first message is posted once");
});

maybe("a failing first message leaves no empty chat behind, and a replay is not rate limited", async () => {
    const s = await seed();
    const { createPrivateChat } = await import("@/lib/private-chats");
    // jsonb refuses \u0000: the message insert fails after the chat row was written.
    await assert.rejects(createPrivateChat({
        companyId: s.companyId, userId: s.owner.userId, agentId: s.agent.id, firstMessage: "with a broken file", clientKey: `fail-${randomUUID()}`,
        attachments: [{ id: randomUUID(), name: "bad\u0000name", contentType: "text/plain", sizeBytes: 1 }],
    }));
    assert.equal((await extraThreadsAndMessages(s.companyId, s.owner.userId, s.agent.id)).threads.length, 0, "no empty chat");

    // Ten creations use up the minute; replaying one of them still answers 200.
    const { companies } = await getSchema();
    const db = await getDb();
    const { eq } = await import("drizzle-orm");
    await db.update(companies).set({ multiChatMaxOpen: 50 }).where(eq(companies.id, s.companyId));
    const keys = Array.from({ length: 10 }, (_, i) => `burst-${i}-${randomUUID()}`);
    for (const key of keys) assert.equal((await newChat(s.member, s.agent.id, "burst", key)).status, 200);
    const replay = await newChat(s.member, s.agent.id, "burst", keys[3]);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.deduplicated, true);
    const fresh = await newChat(s.member, s.agent.id, "one more");
    assert.equal(fresh.status, 429);
    assert.equal(fresh.json.code, "rate_limited");
});

maybe("the cap counts the main chat even before it exists: cap 1 refuses the first extra chat", async () => {
    const s = await seed({ maxOpen: 1 });
    const res = await newChat(s.owner, s.agent.id, "first extra");
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.code, "chat_limit_reached");
    assert.equal(res.json.open, 1);
    assert.equal(res.json.limit, 1);
    assert.equal((await liveChats(s.companyId, s.owner.userId, s.agent.id)).length, 0, "the refusal rolls back: no extra chat");
    // With room for two, the first extra chat is created next to the main chat.
    const { companies } = await getSchema();
    const db = await getDb();
    const { eq } = await import("drizzle-orm");
    await db.update(companies).set({ multiChatMaxOpen: 2 }).where(eq(companies.id, s.companyId));
    assert.equal((await newChat(s.owner, s.agent.id, "first extra")).status, 200);
    assert.equal((await newChat(s.owner, s.agent.id, "second extra")).status, 409, "main + 1 extra = the cap of 2");
    const live = await liveChats(s.companyId, s.owner.userId, s.agent.id);
    assert.deepEqual(live.map((t) => t.isMain).sort(), [false, true]);
});

maybe("a chat started with only an attachment or a voice note is untitled", async () => {
    const s = await seed();
    const { createPrivateChat } = await import("@/lib/private-chats");
    const voice = await createPrivateChat({
        companyId: s.companyId, userId: s.owner.userId, agentId: s.agent.id, firstMessage: "Voice message (12s)", clientKey: `voice-${randomUUID()}`,
        attachments: [{ id: randomUUID(), name: "voice.webm", contentType: "audio/webm", sizeBytes: 10 }],
    });
    assert.equal(voice.thread.title, null);
    const file = await createPrivateChat({
        companyId: s.companyId, userId: s.owner.userId, agentId: s.agent.id, firstMessage: "", clientKey: `file-${randomUUID()}`,
        attachments: [{ id: randomUUID(), name: "plan.pdf", contentType: "application/pdf", sizeBytes: 10 }],
    });
    assert.equal(file.thread.title, null);
});

maybe("/goal typed in an extra chat runs the objective there; archiving that chat is refused while it can run", async () => {
    const s = await seed();
    const created = await newChat(s.owner, s.agent.id, "side topic");
    const extraId = (created.json.thread as { id: string }).id;
    const { POST } = await import("@/app/api/chat/route");
    const goal = (text: string, directThreadId?: string, person = s.owner, agentId = s.agent.id) => {
        actAs(person);
        return call(POST, "/api/chat", { method: "POST", body: { text, targetAgentId: agentId, ...(directThreadId ? { directThreadId } : {}) } });
    };
    const start = await goal("/goal ship the report, verified by a PDF link", extraId);
    assert.equal(start.status, 200, start.text);
    const db = await getDb();
    const { agentObjectives, threadMessages } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const [objective] = await db.select().from(agentObjectives).where(eq(agentObjectives.agentId, s.agent.id));
    assert.equal(objective.threadId, extraId, "bound to the chat it was started from");
    const prompts = await db.select().from(threadMessages).where(and(eq(threadMessages.threadId, extraId), eq(threadMessages.senderType, "system")));
    assert.ok(prompts.some((m) => (m.metadataJson as Record<string, unknown>).objectiveFollowup === true), "the start prompt lands in that chat");

    const status = await goal("/goal status", extraId);
    assert.equal(status.status, 200, status.text);
    assert.equal((status.json.thread as { id: string }).id, extraId, "status answers in the same chat");

    const archive = await patchChat(s.owner, extraId, { archived: true });
    assert.equal(archive.status, 409, archive.text);
    assert.equal(archive.json.code, "objective_running");
    assert.equal((await goal("/goal pause", extraId)).status, 200);
    assert.equal((await patchChat(s.owner, extraId, { archived: true })).status, 409, "a paused objective still holds the chat");
    assert.equal((await goal("/goal stop", extraId)).status, 200);
    const archived = await patchChat(s.owner, extraId, { archived: true });
    assert.equal(archived.status, 200, archived.text);

    // No thread id: the main chat, as before.
    const other = await seed();
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const main = await ensureDirectThread(other.companyId, other.agent.id, other.owner.userId);
    const plain = await goal("/goal tidy the backlog, verified by zero open bugs", undefined, other.owner, other.agent.id);
    assert.equal(plain.status, 200, plain.text);
    const [mainObjective] = await db.select().from(agentObjectives).where(eq(agentObjectives.agentId, other.agent.id));
    assert.equal(mainObjective.threadId, main.id);
});

maybe("chat list status matches the chat bubble: acting is running, queued and seen are queued", async () => {
    const s = await seed();
    const created = await newChat(s.owner, s.agent.id, "first");
    const threadId = (created.json.thread as { id: string }).id;
    await postIn(s.owner, s.agent.id, threadId, "second");
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const firstId = (created.json.message as { id: string }).id;
    type Row = { id: string; running: boolean; queued: number };
    await db.update(threadMessages).set({ deliveryState: "seen" }).where(eq(threadMessages.id, firstId));
    const seen = ((await listChats(s.owner, s.agent.id)).json.chats as Row[]).find((c) => c.id === threadId)!;
    assert.equal(seen.running, false, "a seen message reads Queued, not running");
    assert.equal(seen.queued, 2);
    await db.update(threadMessages).set({ deliveryState: "acting" }).where(eq(threadMessages.id, firstId));
    const acting = ((await listChats(s.owner, s.agent.id)).json.chats as Row[]).find((c) => c.id === threadId)!;
    assert.equal(acting.running, true);
    assert.equal(acting.queued, 1);
});

maybe("PATCH /api/chat/threads/[id] is rate limited per person", async () => {
    const s = await seed();
    const created = await newChat(s.owner, s.agent.id, "rename me");
    const threadId = (created.json.thread as { id: string }).id;
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await patchChat(s.owner, threadId, { title: `name ${i}` })).status);
    assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200));
    assert.equal(statuses[30], 429);
});

maybe("a message racing an archive is refused (409 chat_archived), never left queued in the archived chat", async () => {
    const s = await seed();
    const created = await newChat(s.owner, s.agent.id, "first");
    const threadId = (created.json.thread as { id: string }).id;
    const db = await getDb();
    const { messageThreads, threadMessages } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    // Hold the thread row the way an archive does (FOR UPDATE), start the send
    // while the chat still reads as live, then archive and commit.
    let pending: ReturnType<typeof postIn> | null = null;
    await db.transaction(async (tx) => {
        await tx.select().from(messageThreads).where(eq(messageThreads.id, threadId)).for("update");
        pending = postIn(s.owner, s.agent.id, threadId, "racing the archive");
        await new Promise((resolve) => setTimeout(resolve, 500));
        await tx.update(messageThreads).set({ archivedAt: new Date(), archiveReason: "manual" }).where(eq(messageThreads.id, threadId));
    });
    const res = await pending!;
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.code, "chat_archived");
    const racing = await db.select().from(threadMessages).where(and(eq(threadMessages.threadId, threadId), eq(threadMessages.text, "racing the archive")));
    assert.equal(racing.length, 0);
});
