import test from "node:test";
import assert from "node:assert/strict";
import {
    chatCountHint, filterChatsByTitle, groupChatsByRecency, isValidClientKey, leastRecentlyUsedChats,
    newChatClientKey, orderChats, queuedBusyState, switcherChats, type ChatListEntry,
} from "../../src/lib/multi-chat";
import { lastChatStorageKey, rememberableSelection, resolveDirectSelection } from "../../src/lib/chat-selection";

/** Multi-chat P2 (docs/design/multi-chat-per-agent.md §6): the switcher, "All chats", the cap dialog and routing. */

const NOW = new Date(2026, 10, 12, 15, 0, 0); // 12 Nov 2026, 15:00 local

function chat(id: string, at: Date | null, extra: Partial<ChatListEntry> = {}): ChatListEntry {
    return {
        id, title: id, isMain: false, createdAt: new Date(2026, 0, 1).toISOString(), lastMessageAt: at ? at.toISOString() : null,
        unread: 0, running: false, queued: 0, ...extra,
    };
}

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - d, 12);

test("the main chat is pinned first, then chats by last activity", () => {
    const ordered = orderChats([chat("old", daysAgo(9)), chat("main", daysAgo(30), { isMain: true }), chat("new", hoursAgo(1)), chat("never", null)]);
    assert.deepEqual(ordered.map((c) => c.id), ["main", "new", "old", "never"], "a chat with no message sorts by its creation");
});

test("the switcher shows main plus the most recent up to 8, the rest are under All chats", () => {
    const chats = [chat("main", daysAgo(40), { isMain: true }), ...Array.from({ length: 10 }, (_, i) => chat(`c${i}`, hoursAgo(i + 1)))];
    const { shown, more } = switcherChats(chats);
    assert.equal(shown.length, 8);
    assert.equal(shown[0].id, "main");
    assert.deepEqual(shown.slice(1).map((c) => c.id), ["c0", "c1", "c2", "c3", "c4", "c5", "c6"]);
    assert.equal(more, 3);
    assert.deepEqual(switcherChats([chat("main", null, { isMain: true })]), { shown: [chat("main", null, { isMain: true })], more: 0 });
});

test("All chats groups by the viewer's local day: today, the six days before, older", () => {
    const groups = groupChatsByRecency([
        chat("this-morning", new Date(2026, 10, 12, 0, 5)),
        chat("yesterday-late", new Date(2026, 10, 11, 23, 59)),
        chat("six-days", daysAgo(6)),
        chat("seven-days", daysAgo(7)),
        chat("an-hour", hoursAgo(1)),
    ], NOW);
    assert.deepEqual(groups.today.map((c) => c.id), ["an-hour", "this-morning"]);
    assert.deepEqual(groups.last7Days.map((c) => c.id), ["yesterday-late", "six-days"]);
    assert.deepEqual(groups.older.map((c) => c.id), ["seven-days"]);
});

test("the title filter ignores case and uses the label the viewer sees", () => {
    const chats = [chat("a", null, { title: "Launch EMAIL" }), chat("b", null, { title: null }), chat("m", null, { isMain: true, title: null })];
    const label = (c: ChatListEntry) => c.isMain ? "Main chat" : c.title ?? "New chat";
    assert.deepEqual(filterChatsByTitle(chats, "email", label).map((c) => c.id), ["a"]);
    assert.deepEqual(filterChatsByTitle(chats, " main ", label).map((c) => c.id), ["m"]);
    assert.equal(filterChatsByTitle(chats, "", label).length, 3);
});

test("the cap dialog offers the least recently used extra chats, never main or busy ones", () => {
    const lru = leastRecentlyUsedChats([
        chat("main", daysAgo(90), { isMain: true }),
        chat("busy", daysAgo(80), { running: true }),
        chat("waiting", daysAgo(70), { queued: 1 }),
        chat("oldest", daysAgo(60)),
        chat("newest", hoursAgo(1)),
        chat("middle", daysAgo(3)),
    ], 2);
    assert.deepEqual(lru.map((c) => c.id), ["oldest", "middle"]);
});

test("the count hint appears from 15 open chats, or at a lower cap", () => {
    assert.equal(chatCountHint(14, 20), null);
    assert.deepEqual(chatCountHint(15, 20), { open: 15, limit: 20 });
    assert.equal(chatCountHint(2, 3), null);
    assert.deepEqual(chatCountHint(3, 3), { open: 3, limit: 3 });
});

test("queued-busy uses the runtime's real parallel limit (unknown = 1) and counts only other chats", () => {
    const base = { lastMessageQueued: true, currentThreadId: "here" };
    assert.deepEqual(queuedBusyState({ ...base, runningThreadIds: ["a", "b"], maxParallelTurns: 3 }), { show: false, others: 2 });
    assert.deepEqual(queuedBusyState({ ...base, runningThreadIds: ["a", "b", "c"], maxParallelTurns: 3 }), { show: true, others: 3 });
    assert.deepEqual(queuedBusyState({ ...base, runningThreadIds: ["a"], maxParallelTurns: null }), { show: true, others: 1 });
    assert.deepEqual(queuedBusyState({ ...base, runningThreadIds: ["here"], maxParallelTurns: null }), { show: false, others: 0 },
        "the chat's own run is not 'other chats'");
    assert.equal(queuedBusyState({ ...base, lastMessageQueued: false, runningThreadIds: ["a"], maxParallelTurns: 1 }).show, false);
});

test("queued-busy counts only the person's own other chats, while any work elsewhere still makes the agent busy", () => {
    const base = { lastMessageQueued: true, currentThreadId: "here", maxParallelTurns: 2, ownChatIds: ["here", "mine"] };
    // A task run (null thread) and someone else's chat fill the runtime; one of the person's chats runs too.
    assert.deepEqual(queuedBusyState({ ...base, runningThreadIds: [null, "theirs", "mine"] }), { show: true, others: 1 });
    assert.deepEqual(queuedBusyState({ ...base, runningThreadIds: [null, "theirs"] }), { show: true, others: 0 },
        "busy, but not in any of this person's chats");
    assert.deepEqual(queuedBusyState({ ...base, runningThreadIds: ["mine"] }), { show: false, others: 1 });
});

test("a new-chat client key is a valid, unique clientKey", () => {
    const a = newChatClientKey();
    assert.ok(isValidClientKey(a), a);
    assert.notEqual(a, newChatClientKey());
});

/* ---------- Messages routing ---------- */

const own = { "t-extra": "agent-1", "t-main": "agent-1", "t-other": "agent-2" };

test("?thread= is exact: any of the person's chats, with or without ?agent=", () => {
    assert.deepEqual(resolveDirectSelection({ thread: "t-extra", agent: null, knownThreads: own, lastChatFor: () => null, agentKnown: () => true }),
        { agentId: "agent-1", threadId: "t-extra" });
    // An archived (unlisted) chat still opens exactly when the link names its agent.
    assert.deepEqual(resolveDirectSelection({ thread: "t-archived", agent: "agent-1", knownThreads: own, lastChatFor: () => null, agentKnown: () => true }),
        { agentId: "agent-1", threadId: "t-archived" });
    assert.equal(resolveDirectSelection({ thread: "t-unknown", agent: null, knownThreads: own, lastChatFor: () => null, agentKnown: () => true }), null);
});

test("an archived chat opened by link selects its agent's row but is never remembered as last-open", () => {
    const opened = resolveDirectSelection({ thread: "t-archived", agent: "agent-1", knownThreads: own, lastChatFor: () => "t-archived", agentKnown: () => true });
    assert.deepEqual(opened, { agentId: "agent-1", threadId: "t-archived" });
    // What the page remembers: the agent (its main chat), not the archived thread.
    assert.deepEqual(rememberableSelection(opened!, own), { agentId: "agent-1", threadId: null });
    // Listed chats (main or extra) are remembered exactly; a thread listed under another agent is not.
    assert.deepEqual(rememberableSelection({ agentId: "agent-1", threadId: "t-extra" }, own), { agentId: "agent-1", threadId: "t-extra" });
    assert.deepEqual(rememberableSelection({ agentId: "agent-1", threadId: null }, own), { agentId: "agent-1", threadId: null });
    assert.deepEqual(rememberableSelection({ agentId: "agent-1", threadId: "t-other" }, own), { agentId: "agent-1", threadId: null });
});

test("?agent= alone opens the last chat viewed with that agent, else the main chat", () => {
    const last = (agentId: string) => (agentId === "agent-1" ? "t-extra" : null);
    assert.deepEqual(resolveDirectSelection({ thread: null, agent: "agent-1", knownThreads: own, lastChatFor: last, agentKnown: () => true }),
        { agentId: "agent-1", threadId: "t-extra" });
    assert.deepEqual(resolveDirectSelection({ thread: null, agent: "agent-2", knownThreads: own, lastChatFor: last, agentKnown: () => true }),
        { agentId: "agent-2", threadId: null });
    // A remembered chat that is no longer listed (archived elsewhere) falls back to main.
    assert.deepEqual(resolveDirectSelection({ thread: null, agent: "agent-1", knownThreads: {}, lastChatFor: last, agentKnown: () => true }),
        { agentId: "agent-1", threadId: null });
    // A handed-over draft always lands in the main chat.
    assert.deepEqual(resolveDirectSelection({ thread: null, agent: "agent-1", knownThreads: own, lastChatFor: last, agentKnown: () => true, preferMain: true }),
        { agentId: "agent-1", threadId: null });
    assert.equal(resolveDirectSelection({ thread: null, agent: "gone", knownThreads: own, lastChatFor: last, agentKnown: () => false }), null);
});

test("the last-viewed chat is remembered per agent", () => {
    assert.notEqual(lastChatStorageKey("a"), lastChatStorageKey("b"));
});
