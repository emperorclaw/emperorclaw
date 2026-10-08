import assert from "node:assert/strict";
import test from "node:test";
import {
    buildFeed, DONE_TODAY_MS, donePerDay, filterPausedNotices, kpiCounts,
    type ActivityEvent, type DashboardMember, type DashboardTask, type PairThreadActivity, type PausedNotice, type SceneAgent,
} from "../../src/lib/team-scene";

const activity = (eventType: string, at: string, id = "e1"): ActivityEvent => ({
    id, eventType, actorKey: "agent:a1", actorName: "Growth", targetName: null, targetKey: null,
    taskTitle: "Draft", taskId: "t1", projectId: "p1", at,
});

const pair = (threadId: string, at: string, text = "on it"): PairThreadActivity => ({
    id: `m-${threadId}`, threadId, actorKey: "agent:a1", actorName: "Growth", targetKey: "agent:a2", targetName: "QA", text, at,
});

test("buildFeed maps events and pair activity into a capped, newest-first feed", () => {
    const items = buildFeed(
        [
            activity("task_done", "2026-10-07T11:00:00.000Z", "done"),
            activity("task_review", "2026-10-07T10:00:00.000Z", "review"),
            activity("task_assigned", "2026-10-07T09:00:00.000Z", "handoff"),
        ],
        [pair("t", "2026-10-07T10:30:00.000Z")],
        8,
    );
    assert.deepEqual(items.map((i) => i.kind), ["done", "pair", "review", "handoff"]);
    assert.equal(items.length, 4);
    assert.equal(items[0].kind, "done", "newest first");
});

test("buildFeed with no pair activity never emits pair items", () => {
    const items = buildFeed([activity("task_done", "2026-10-07T11:00:00.000Z")], [], 8);
    assert.ok(items.every((i) => i.kind !== "pair"), "no pair text leaks when pair activity is empty");
    assert.equal(items.length, 1);
});

test("filterPausedNotices keeps one notice per thread and drops resumed ones", () => {
    const notices: PausedNotice[] = [
        { id: "n2", threadId: "t1", createdAt: "2026-10-07T11:00:00.000Z", isPairThread: false },
        { id: "n1", threadId: "t1", createdAt: "2026-10-07T10:00:00.000Z", isPairThread: false },
        { id: "n3", threadId: "t2", createdAt: "2026-10-07T12:00:00.000Z", isPairThread: false },
    ];
    // t2 was resumed after its notice.
    const resumes = new Map([["t2", "2026-10-07T13:00:00.000Z"]]);
    const kept = filterPausedNotices(notices, resumes, true);
    assert.deepEqual(kept.map((n) => n.id), ["n2"]);
});

test("filterPausedNotices hides pair-thread notices from non-admins", () => {
    const notices: PausedNotice[] = [
        { id: "n1", threadId: "t1", createdAt: "2026-10-07T11:00:00.000Z", isPairThread: false },
        { id: "n2", threadId: "t2", createdAt: "2026-10-07T11:00:00.000Z", isPairThread: true },
    ];
    assert.deepEqual(filterPausedNotices(notices, new Map(), false).map((n) => n.id), ["n1"]);
    assert.deepEqual(filterPausedNotices(notices, new Map(), true).map((n) => n.id), ["n1", "n2"]);
});

test("donePerDay buckets by rolling 24h windows so today is the last 24h", () => {
    const now = new Date("2026-10-07T12:00:00.000Z");
    const doneAt = [
        new Date(now.getTime() - 60 * 60_000).toISOString(),      // 1h ago → today
        new Date(now.getTime() - 25 * 60 * 60_000).toISOString(), // 25h ago → yesterday
        new Date(now.getTime() - 8 * DONE_TODAY_MS).toISOString(), // 8 days ago → ignored
    ];
    const buckets = donePerDay(doneAt, now, 7);
    assert.equal(buckets[6], 1, "today bucket is the last 24h");
    assert.equal(buckets[5], 1, "yesterday bucket");
    assert.equal(buckets.slice(0, 5).reduce((s, n) => s + n, 0), 0, "older buckets empty");
});

test("kpiCounts 'done' counts members who finished something today, not board rows", () => {
    const member = (key: string, doneToday: number): SceneAgent => ({
        member: { key, kind: "agent", id: key, name: key, role: null, avatarUrl: null, skills: [], health: "healthy", healthReasons: [], activity: null, href: "/", createdAt: null, doneToday, working: [], waiting: [], next: [], spendTodayCents: 0, monthlyCostCents: 0, monthlyBudgetCents: 0, lastActivityAt: null } as DashboardMember,
        status: "idle", activity: "Available", zone: "lounge", behavior: { kind: "nap", caption: "Napping", variant: 0 }, isNew: false,
    });
    const task = (state: string): DashboardTask => ({ id: state, projectId: "p1", projectName: null, title: "T", state, taskType: null, assigneeKey: null, updatedAt: "2026-10-07T10:00:00.000Z", dueAt: null });
    const data = {
        members: [member("agent:a", 3).member, member("agent:b", 0).member],
        attention: [],
        board: { inProgress: [], review: [], done: [task("done"), task("done"), task("done"), task("done")] },
    };
    const agents = [member("agent:a", 3), member("agent:b", 0)];
    assert.equal(kpiCounts(agents, data).done, 1, "one member finished today, regardless of board rows");
});
