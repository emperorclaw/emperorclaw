import { test } from "node:test";
import assert from "node:assert/strict";
import {
    applyAttentionScope, attentionCounts, attentionGroup, inboxFilterCount, latestFailedRuns, matchesInboxFilter, parseInboxFilter, plainText, runFailureReason, sortAttention, workingNowAgentIds,
} from "../../src/lib/attention-rules";
import { requiresHumanAction, type AttentionEntry, type AttentionKind } from "../../src/lib/team-scene";

function entry(id: string, kind: AttentionKind, at: string, extra: Partial<AttentionEntry> = {}): AttentionEntry {
    return { id, kind, title: id, memberKey: null, memberName: null, area: null, at, actionLabel: "Open", href: "/", ...extra };
}

test("groups: decisions, blockers and FYI", () => {
    assert.equal(attentionGroup(entry("a", "approval", "1")), "decide");
    assert.equal(attentionGroup(entry("d", "decision", "1")), "decide");
    for (const kind of ["incident", "agent", "paused", "run_failed", "task_blocked", "request", "stalled"] as const) {
        assert.equal(attentionGroup(entry(kind, kind, "1")), "blocked", kind);
    }
    assert.equal(attentionGroup(entry("m", "message", "1", { actionRequired: true })), "blocked", "a failed delivery needs a person");
    assert.equal(attentionGroup(entry("m", "message", "1")), "fyi", "a slow reply is a signal");
    assert.equal(attentionGroup(entry("n", "not_started", "1", { actionRequired: true })), "blocked", "nobody owns it");
    assert.equal(attentionGroup(entry("n", "not_started", "1")), "fyi");
    assert.equal(attentionGroup(entry("l", "late", "1")), "fyi");
    assert.equal(attentionGroup(entry("@", "mention", "1")), "fyi");
});

test("urgency sort: group first, then kind, then oldest first, stable on ties", () => {
    const sorted = sortAttention([
        entry("late", "late", "2026-01-01T00:00:00Z"),
        entry("approval-new", "approval", "2026-01-03T00:00:00Z"),
        entry("incident", "incident", "2026-01-05T00:00:00Z"),
        entry("approval-old", "approval", "2026-01-02T00:00:00Z"),
        entry("decision", "decision", "2026-01-01T00:00:00Z"),
        entry("run", "run_failed", "2026-01-04T00:00:00Z"),
        entry("tie-1", "mention", "2026-01-09T00:00:00Z"),
        entry("tie-2", "mention", "2026-01-09T00:00:00Z"),
    ]);
    // Approvals and chat decisions are equally urgent: the one waiting longest leads.
    assert.deepEqual(sorted.map((e) => e.id), ["decision", "approval-old", "approval-new", "incident", "run", "late", "tie-1", "tie-2"]);
});

test("one definition: needs-you is exactly requiresHumanAction (dashboard, inbox and badge agree)", () => {
    const kinds: AttentionKind[] = ["approval", "decision", "incident", "agent", "paused", "run_failed", "task_blocked", "request", "stalled", "message", "late", "not_started", "mention"];
    for (const kind of kinds) {
        for (const actionRequired of [undefined, true, false]) {
            const e = entry(kind, kind, "1", actionRequired === undefined ? {} : { actionRequired });
            assert.equal(attentionGroup(e) !== "fyi", requiresHumanAction(e), `${kind} actionRequired=${actionRequired}`);
        }
    }
});

test("member scope hides other agents and other customers' projects", () => {
    const entries = [
        entry("mine", "approval", "1", { memberKey: "agent:a1", projectId: "p1", customerId: "c1" }),
        entry("other-agent", "run_failed", "1", { agentId: "a2", memberKey: "agent:a2" }),
        entry("other-customer", "incident", "1", { memberKey: "agent:a1", projectId: "p2", customerId: "c2" }),
        entry("no-customer-project", "task_blocked", "1", { projectId: "p3", customerId: null }),
        entry("human-only", "mention", "1"),
        entry("human-task", "late", "1", { memberKey: "human:m1", projectId: "p1", customerId: "c1" }),
    ];
    const visible = applyAttentionScope(entries, { agentIds: ["a1"], customerIds: ["c1"] }).map((e) => e.id);
    assert.deepEqual(visible, ["mine", "human-only", "human-task"]);
    assert.equal(applyAttentionScope(entries, null).length, entries.length, "unrestricted members see everything");
    assert.deepEqual(applyAttentionScope(entries, { agentIds: [], customerIds: [] }).map((e) => e.id), ["human-only"], "an empty allow-list grants nothing (fail closed)");
    assert.deepEqual(applyAttentionScope(entries, { agentIds: ["a1"] }).map((e) => e.id), ["mine", "other-customer", "no-customer-project", "human-only", "human-task"]);
});

test("counts: the badge is decisions plus blockers; failures turn it red", () => {
    const quiet = attentionCounts([entry("a", "approval", "1"), entry("m", "mention", "1"), entry("l", "late", "1")]);
    assert.deepEqual(quiet, { needsYou: 1, decide: 1, blocked: 0, fyi: 2, approvals: 1, hasFailures: false, unread: 1 });
    const broken = attentionCounts([entry("r", "run_failed", "1"), entry("m", "message", "1", { actionRequired: true })]);
    assert.equal(broken.needsYou, 2);
    assert.equal(broken.hasFailures, true);
    assert.equal(attentionCounts([entry("p", "paused", "1")]).hasFailures, false, "a paused loop is blocked, not broken");
});

test("inbox views: Decisions + Blocked = Needs you; FYI is counted apart", () => {
    assert.equal(parseInboxFilter(undefined), "needs");
    assert.equal(parseInboxFilter("nope"), "needs");
    assert.equal(parseInboxFilter("approvals"), "decide", "old links keep working");
    assert.equal(parseInboxFilter("problems"), "blocked");
    assert.equal(parseInboxFilter("fyi"), "fyi");
    const entries = [
        entry("a", "approval", "1"), entry("d", "decision", "1"), entry("r", "run_failed", "1"), entry("s", "stalled", "1"),
        entry("l", "late", "1"), entry("@", "mention", "1"), entry("m", "message", "1"),
    ];
    const listed = (f: Parameters<typeof matchesInboxFilter>[1]) => entries.filter((e) => matchesInboxFilter(e, f)).length;
    const counts = attentionCounts(entries);
    for (const f of ["needs", "decide", "blocked", "fyi"] as const) assert.equal(inboxFilterCount(counts, f), listed(f), `${f}: the number is what is listed`);
    assert.equal(listed("decide") + listed("blocked"), listed("needs"));
    assert.equal(listed("needs"), counts.needsYou, "the header and badge");
    assert.equal(listed("fyi"), 3);
});

test("working now: typing, or connected and holding unstuck in-progress work", () => {
    const ids = workingNowAgentIds({
        typing: new Set(["typist"]),
        connected: new Set(["busy", "stuck", "down", "chat-only"]),
        down: new Set(["down"]),
        inProgress: [
            { agentId: "busy", taskId: "t1" },
            { agentId: "stuck", taskId: "t2" },
            { agentId: "down", taskId: "t3" },
            { agentId: "offline", taskId: "t4" },
        ],
        entries: [entry("i", "incident", "1", { memberKey: "agent:stuck", taskId: "t2" })],
    });
    assert.deepEqual(ids, ["busy", "typist"]);
});

test("failed runs: only an agent's latest run, and only when it failed", () => {
    const run = (id: string, agentId: string | null, status: string, minute: number) => ({ id, agentId, status, startedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)) });
    const out = latestFailedRuns([
        run("a-old-fail", "a", "failed", 1),
        run("a-ok", "a", "succeeded", 5),
        run("b-fail", "b", "timeout", 3),
        run("b-older", "b", "succeeded", 2),
        run("c-running", "c", "running", 9),
        run("c-fail", "c", "failed", 4),
        run("orphan", null, "failed", 9),
    ]);
    assert.deepEqual(out.map((r) => r.id), ["b-fail"]);
    assert.equal(runFailureReason({ status: "timeout" }), "Timed out");
    assert.equal(runFailureReason({ status: "failed", error: "  provider\n 402  " }), "provider 402");
    assert.equal(runFailureReason({ status: "failed", error: "x".repeat(200) }, 10).length, 10);
});

test("notification bodies read as prose: rich blocks and markdown dropped", () => {
    assert.equal(plainText('We are within budget. stats [{"label":"x"}] chart {"type":1}').trim(), "We are within budget.");
    assert.equal(plainText("Pick one:\n```choices\n- A\n- B\n```\nThanks **Ana**").replace(/\s+/g, " ").trim(), "Pick one: Thanks Ana");
    assert.equal(plainText("See [the brief](https://x.test) first").trim(), "See the brief first");
});
