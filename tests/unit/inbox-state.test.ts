import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionCounts } from "../../src/lib/attention-rules";
import {
    INBOX_STATE_MAX_ITEMS, inboxFingerprint, inboxStatePatch, isArchivedNow, isReadNow, matchesInboxSearch, parseInboxStateRequest, splitArchived, withInboxState,
    type InboxItemStateRow,
} from "../../src/lib/inbox-state-rules";
import type { AttentionEntry, AttentionKind } from "../../src/lib/team-scene";

function entry(id: string, kind: AttentionKind, at: string, extra: Partial<AttentionEntry> = {}): AttentionEntry {
    return { id, kind, title: id, memberKey: null, memberName: null, area: null, at, actionLabel: "Open", href: "/", ...extra };
}

function row(itemKey: string, extra: Partial<InboxItemStateRow> = {}): InboxItemStateRow {
    return { itemKey, readAt: null, readFingerprint: null, archivedAt: null, archivedFingerprint: null, ...extra };
}

test("fingerprint: stable for the same state, new for a new occurrence", () => {
    const a = entry("agent:1", "agent", "2026-10-01T10:00:00Z");
    assert.equal(inboxFingerprint(a), inboxFingerprint({ ...a, title: "renamed" }), "copy changes are not a new state");
    assert.match(inboxFingerprint(a), /^[0-9a-f]{8}$/);
    assert.notEqual(inboxFingerprint(a), inboxFingerprint({ ...a, at: "2026-10-02T10:00:00Z" }), "a later offline spell");
    assert.notEqual(inboxFingerprint(a), inboxFingerprint({ ...a, kind: "run_failed" }));
    assert.notEqual(
        inboxFingerprint({ ...a, failure: { cause: "runtime_offline" } as AttentionEntry["failure"] }),
        inboxFingerprint({ ...a, failure: { cause: "out_of_credits" } as AttentionEntry["failure"] }),
        "a different cause is a different problem",
    );
    // A seed replaces `at` when `at` moves on its own (a connected agent's heartbeat).
    const seeded = { ...a, fingerprintSeed: "connected" };
    assert.equal(inboxFingerprint(seeded), inboxFingerprint({ ...seeded, at: "2026-10-09T00:00:00Z" }));
});

test("archive hides an item until it changes, then it resurfaces unread", () => {
    const before = entry("agent:1", "agent", "2026-10-01T10:00:00Z");
    const fp = inboxFingerprint(before);
    const stored = row("agent:1", { ...inboxStatePatch("archive", fp, new Date("2026-10-01T11:00:00Z")) });
    assert.equal(isArchivedNow(stored, fp), true);
    assert.equal(isReadNow(stored, fp), true, "archiving also reads it");

    const [same] = withInboxState([before], [stored]);
    assert.equal(same.archived, true);

    const again = entry("agent:1", "agent", "2026-10-03T08:00:00Z");
    const [back] = withInboxState([again], [stored]);
    assert.equal(back.archived, false, "the agent went offline again: back in the inbox");
    assert.equal(back.read, false, "and unread");
});

test("read, unread and unarchive patches", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    assert.deepEqual(inboxStatePatch("read", "abc", now), { readAt: now, readFingerprint: "abc" });
    assert.deepEqual(inboxStatePatch("unread", "abc", now), { readAt: null, readFingerprint: null });
    assert.deepEqual(inboxStatePatch("unarchive", "abc", now), { archivedAt: null, archivedFingerprint: null });
    assert.equal(isReadNow(row("x", { readAt: now, readFingerprint: "abc" }), "def"), false, "read applies to the state it was read in");
    assert.equal(isReadNow(null, "abc"), false);
    assert.equal(isArchivedNow(row("x", { archivedAt: null, archivedFingerprint: "abc" }), "abc"), false);
});

test("state is per item key; split and counts ignore archived items", () => {
    const items = [entry("approval:1", "approval", "1"), entry("agent:2", "agent", "2"), entry("mention:3", "mention", "3")];
    const fps = items.map(inboxFingerprint);
    const flagged = withInboxState(items, [
        row("approval:1", { readAt: new Date(), readFingerprint: fps[0] }),
        row("agent:2", { archivedAt: new Date(), archivedFingerprint: fps[1], readAt: new Date(), readFingerprint: fps[1] }),
    ]);
    const { active, archived } = splitArchived(flagged);
    assert.deepEqual(active.map((e) => e.id), ["approval:1", "mention:3"]);
    assert.deepEqual(archived.map((e) => e.id), ["agent:2"]);
    const counts = attentionCounts(active);
    assert.equal(counts.needsYou, 1);
    assert.equal(counts.unread, 0, "the approval is read; FYI never counts toward the badge");
    assert.equal(attentionCounts(withInboxState(items, [])).unread, 2, "nothing read: both needs-you items");
});

test("request parsing: actions, keys, fingerprints and the 200-item cap", () => {
    assert.equal(parseInboxStateRequest({ action: "delete", items: [{ key: "a" }] }).ok, false);
    assert.equal(parseInboxStateRequest({ action: "read", items: [] }).ok, false);
    assert.equal(parseInboxStateRequest({ action: "read", items: [{ key: "" }] }).ok, false);
    assert.equal(parseInboxStateRequest({ action: "read", items: [{ key: "a", fingerprint: 5 }] }).ok, false);
    assert.equal(parseInboxStateRequest(null).ok, false);
    const tooMany = Array.from({ length: INBOX_STATE_MAX_ITEMS + 1 }, (_, i) => ({ key: `k${i}` }));
    assert.equal(parseInboxStateRequest({ action: "archive", items: tooMany }).ok, false);
    const ok = parseInboxStateRequest({ action: "archive", items: [{ key: "a", fingerprint: "f1" }, { key: "b" }, { key: "a", fingerprint: "f2" }] });
    assert.ok(ok.ok);
    if (ok.ok) assert.deepEqual(ok.value.items, [{ key: "a", fingerprint: "f2" }, { key: "b", fingerprint: null }], "duplicates collapse to the last");
});

test("search matches title, agent, project and customer, every word", () => {
    const e = entry("t", "task_blocked", "1", { title: "Winter menu", memberName: "Bob", area: "Harbor menu", customerName: "Harbor Bakery" });
    assert.equal(matchesInboxSearch(e, ""), true);
    assert.equal(matchesInboxSearch(e, "winter"), true);
    assert.equal(matchesInboxSearch(e, "bob harbor"), true);
    assert.equal(matchesInboxSearch(e, "bakery"), true);
    assert.equal(matchesInboxSearch(e, "summer"), false);
    assert.equal(matchesInboxSearch(e, "bob summer"), false);
});

test("realtime: a state change refreshes only that person's inbox tabs", async () => {
    const { eventTopicsFor } = await import("../../src/lib/realtime-topics");
    const { humanSocketReceives, socketReceives } = await import("../../src/lib/realtime-delivery");
    assert.ok(eventTopicsFor({ type: "inbox_state_updated" }, null).includes("inbox"));
    // The audience broadcastUserEvent (src/lib/pubsub.ts) sends.
    const event = { companyId: "c1", audience: { agentId: null, ownerUserId: "u1" }, subject: { projectIds: [], customerIds: [], agentIds: [] } };
    assert.equal(humanSocketReceives(event, { companyId: "c1", userId: "u1" }), true);
    assert.equal(humanSocketReceives(event, { companyId: "c1", userId: "u2" }), false, "another person");
    assert.equal(humanSocketReceives(event, { companyId: "c2", userId: "u1" }), false, "another company");
    assert.equal(socketReceives(event, { companyId: "c1", agentId: "a1" }), false, "no agent socket");
    assert.equal(socketReceives(event, { companyId: "c1", agentId: null }), false, "not even a company-wide token");
});
