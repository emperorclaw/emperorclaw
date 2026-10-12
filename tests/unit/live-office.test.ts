import assert from "node:assert/strict";
import { test } from "node:test";
import {
    bubbleCandidates, bubbleText, deskColumns, deskStatusLine, eventsToPlay, formatElapsed, ghostKeys, orderByUrgency, plural, rotateSpeakers, updatedAgo, urgencyBucket, visibleDesks,
} from "../../src/lib/live-office";
import { dashboardLiveFromRows, pendingApprovalRows } from "../../src/lib/dashboard-live";
import { deriveSceneAgents, type DashboardMember, type SceneAgent, type SceneLiveEvent } from "../../src/lib/team-scene";
import type { ReasoningRow } from "../../src/lib/live-feed-v2";
import { dashboardFixture } from "../fixtures/dashboard";

const NOW = new Date("2026-10-12T12:00:00Z");

function agent(name: string, status: SceneAgent["status"], over: Partial<DashboardMember> = {}): SceneAgent {
    const member: DashboardMember = {
        key: `agent:${name.toLowerCase()}`, kind: "agent", id: name.toLowerCase(), name, role: null, avatarUrl: null, skills: [], health: "healthy", healthReasons: [],
        activity: null, href: "", createdAt: null, doneToday: 0, working: [], waiting: [], next: [], spendTodayCents: 0, monthlyCostCents: 0, monthlyBudgetCents: 0, lastActivityAt: null,
        runtimeOnline: true, ...over,
    };
    return { member, status, activity: "Available", zone: "operations", behavior: { kind: "available", caption: "Available", variant: 0 }, isNew: false };
}

const task = (title: string, state: string, at: { startedAt?: string | null; updatedAt?: string }) => ({
    id: `t-${title}`, projectId: "p", projectName: null, title, state, taskType: null, assigneeKey: null, updatedAt: at.updatedAt ?? NOW.toISOString(), dueAt: null, startedAt: at.startedAt ?? null,
});

test("desks order by urgency: needs-you, blocked, stale, review, working, idle, offline", () => {
    const agents = [
        agent("Zed", "idle", { runtimeOnline: false }),
        agent("Yan", "idle"),
        agent("Xia", "working"),
        agent("Wes", "waiting"),
        agent("Val", "offline"),
        agent("Uma", "blocked"),
        agent("Tom", "working"),
    ];
    const needsYou = new Set(["agent:tom"]);
    assert.deepEqual(orderByUrgency(agents, needsYou).map((a) => a.member.name), ["Tom", "Uma", "Val", "Wes", "Xia", "Yan", "Zed"]);
    assert.equal(urgencyBucket(agents[0], needsYou), "offline");
    assert.equal(urgencyBucket(agents[1], needsYou), "idle");
});

test("order inside a bucket is stable by name, whatever the input order", () => {
    const agents = [agent("Mira", "working"), agent("Ada", "working"), agent("Quinn", "working"), agent("Bea", "blocked")];
    const forward = orderByUrgency(agents, new Set()).map((a) => a.member.name);
    const reversed = orderByUrgency([...agents].reverse(), new Set()).map((a) => a.member.name);
    assert.deepEqual(forward, ["Bea", "Ada", "Mira", "Quinn"]);
    assert.deepEqual(reversed, forward);
});

test("needs-you agents from the fixture take the front row", () => {
    const data = dashboardFixture(12);
    const agents = deriveSceneAgents(data);
    const needsYou = new Set(data.attention.filter((e) => e.kind === "approval" || e.kind === "agent").flatMap((e) => (e.memberKey ? [e.memberKey] : [])));
    const ordered = orderByUrgency(agents, needsYou);
    const firstOther = ordered.findIndex((a) => !needsYou.has(a.member.key));
    assert.ok(firstOther > 0);
    assert.ok(ordered.slice(firstOther).every((a) => !needsYou.has(a.member.key)), "no needs-you desk sits behind another bucket");
});

test("status line shows the real task and its elapsed time", () => {
    const working = agent("Ada", "working", { working: [task("Answering 47 emails", "in_progress", { startedAt: new Date(NOW.getTime() - 12 * 60_000).toISOString() })] });
    assert.deepEqual(deskStatusLine(working, NOW), { text: "Answering 47 emails · 12m", task: "Answering 47 emails", elapsed: "12m" });

    const review = agent("Bo", "waiting", { waiting: [task("Q3 report", "review", { updatedAt: new Date(NOW.getTime() - 2 * 3600_000 - 5 * 60_000).toISOString() })] });
    assert.equal(deskStatusLine(review, NOW).text, "Q3 report · 2h 5m");

    const noStart = agent("Cy", "working", { working: [task("Draft", "in_progress", { startedAt: null })] });
    assert.equal(deskStatusLine(noStart, NOW).text, "Draft", "no invented elapsed time without a start");

    const idle = { ...agent("Di", "idle"), activity: "Available" };
    assert.deepEqual(deskStatusLine(idle, NOW), { text: "Available", task: null, elapsed: null });

    const long = agent("Ed", "working", { working: [task("x".repeat(200), "in_progress", { startedAt: NOW.toISOString() })] });
    const line = deskStatusLine(long, NOW);
    assert.ok(Array.from(line.task ?? "").length <= 64 && line.task?.endsWith("…"));
    assert.ok(line.text.endsWith(" · <1m"));
});

test("elapsed formatting and pluralization", () => {
    assert.equal(formatElapsed(30_000), "<1m");
    assert.equal(formatElapsed(59 * 60_000), "59m");
    assert.equal(formatElapsed(3 * 3600_000), "3h");
    assert.equal(formatElapsed(50 * 3600_000), "2d");
    assert.equal(plural(1, "pending action"), "1 pending action");
    assert.equal(plural(3, "pending action"), "3 pending actions");
    assert.equal(updatedAgo("2026-10-12T11:59:48Z", NOW.getTime()), "Updated 12s ago");
    assert.equal(updatedAgo("2026-10-12T11:57:00Z", NOW.getTime()), "Updated 3m ago");
});

test("team chat filter ghosts other desks in place instead of removing them", () => {
    const agents = [agent("Ada", "working"), agent("Bo", "idle"), agent("Cy", "blocked")];
    assert.deepEqual([...ghostKeys(agents, null)], []);
    const ghosts = ghostKeys(agents, { memberKeys: ["agent:ada"] });
    assert.deepEqual([...ghosts].sort(), ["agent:bo", "agent:cy"]);
    const { shown, hidden } = visibleDesks(orderByUrgency(agents, new Set()), ghosts);
    assert.equal(shown.length, 3, "ghosts keep their desks");
    assert.equal(hidden, 0);
});

test("past 24 desks, team members keep their seats and the rest overflow", () => {
    const agents = Array.from({ length: 30 }, (_, i) => agent(`A${String(i).padStart(2, "0")}`, "idle"));
    const team = { memberKeys: agents.slice(25).map((a) => a.member.key) };
    const { shown, hidden } = visibleDesks(orderByUrgency(agents, new Set()), ghostKeys(agents, team), 24);
    assert.equal(shown.length, 24);
    assert.equal(hidden, 6);
    assert.ok(team.memberKeys.every((k) => shown.some((a) => a.member.key === k)));
    assert.deepEqual(shown.map((a) => a.member.name), [...shown.map((a) => a.member.name)].sort(), "still in urgency/name order");
});

test("thought bubbles: fresh working agents only, two at a time, rotating", () => {
    const at = (sec: number) => new Date(NOW.getTime() - sec * 1000).toISOString();
    const thoughts = [
        { memberKey: "agent:a", text: "Checking the migration order", at: at(5) },
        { memberKey: "agent:b", text: "Comparing supplier quotes", at: at(30) },
        { memberKey: "agent:c", text: "Too old", at: at(11 * 60) },
        { memberKey: "agent:d", text: "Not working", at: at(10) },
        { memberKey: "agent:e", text: "Drafting the reply", at: at(60) },
    ];
    const pool = bubbleCandidates(thoughts, new Set(["agent:a", "agent:b", "agent:c", "agent:e"]), NOW.getTime());
    assert.deepEqual(pool.map((t) => t.memberKey), ["agent:a", "agent:b", "agent:e"]);
    assert.equal(rotateSpeakers(pool, 0).length, 2);
    const seen = new Set([0, 1, 2, 3].flatMap((tick) => rotateSpeakers(pool, tick).map((t) => t.memberKey)));
    assert.equal(seen.size, 3, "every working agent gets a turn");
    const snippet = bubbleText("word ".repeat(40));
    assert.ok(Array.from(snippet).length <= 80 && snippet.endsWith("…"));
});

test("events play once, only when recent and on the floor", () => {
    const at = (sec: number) => new Date(NOW.getTime() - sec * 1000).toISOString();
    const events: SceneLiveEvent[] = [
        { id: "h1", type: "handoff", actorKey: "agent:a", targetKey: "agent:b", title: null, at: at(20) },
        { id: "d1", type: "task_done", actorKey: "agent:a", targetKey: null, title: "Report", at: at(200) },
        { id: "n1", type: "needs_you", actorKey: "agent:z", targetKey: null, title: "Approve", at: at(5) },
        { id: "h2", type: "handoff", actorKey: "agent:a", targetKey: "agent:z", title: null, at: at(5) },
        { id: "d2", type: "task_done", actorKey: "agent:b", targetKey: null, title: "Done", at: at(10) },
    ];
    const floor = new Set(["agent:a", "agent:b"]);
    assert.deepEqual(eventsToPlay(events, new Set(), floor, NOW.getTime()).map((e) => e.id), ["h1", "d2"], "oldest first; stale, unseen-agent and off-floor handoffs skipped");
    assert.deepEqual(eventsToPlay(events, new Set(["h1", "d2"]), floor, NOW.getTime()), []);
});

test("dashboard thoughts never come from a direct thread", () => {
    const nowMs = NOW.getTime();
    const row = (agentId: string, threadType: string, sec: number, reasoning: string): ReasoningRow => ({ agentId, messageId: `${agentId}-${threadType}-${sec}`, threadType, createdAtMs: nowMs - sec * 1000, reasoning, truncatedHead: false });
    const live = dashboardLiveFromRows({
        reasoning: [
            row("ada", "direct", 5, "The customer's private salary negotiation needs a careful reply"),
            row("ada", "team", 60, "Comparing the two supplier quotes before the call"),
            row("bo", "direct", 5, "Only private reasoning exists for this agent today"),
            row("cy", "group", 30, "Checking the migration order against production"),
            row("ghost", "team", 5, "An agent that is not in this company roster"),
        ],
        handoffs: [], transitions: [], approvals: [],
        agents: [{ id: "ada", name: "Ada" }, { id: "bo", name: "Bo" }, { id: "cy", name: "Cy" }],
        nowMs,
    });
    const byKey = new Map(live.thoughts.map((t) => [t.memberKey, t.text]));
    assert.equal(byKey.get("agent:ada"), "Comparing the two supplier quotes before the call", "the newer direct thought is skipped");
    assert.equal(byKey.has("agent:bo"), false, "direct-only reasoning never shows");
    assert.equal(byKey.get("agent:cy"), "Checking the migration order against production");
    assert.equal(byKey.has("agent:ghost"), false);
    assert.ok(live.thoughts.every((t) => !/salary|private/.test(t.text)));
});

test("dashboard events reuse the device feed derivation, keyed by member", () => {
    const nowMs = NOW.getTime();
    const live = dashboardLiveFromRows({
        reasoning: [],
        handoffs: [{ id: "m1", senderId: "ada", targetAgentId: null, text: "@Bo can you take the deploy?", createdAtMs: nowMs - 20_000 }],
        transitions: [{ id: "e1", state: "done", actorType: "agent", actorId: "bo", assignedAgentId: "bo", title: "Ship the report", createdAtMs: nowMs - 30_000 }],
        approvals: pendingApprovalRows([{ id: "ap1", requesterAgentId: "ada", actionType: "task_done", rationale: null, requestedAt: new Date(nowMs - 5_000), taskInput: { title: "Publish post" }, taskType: "content" }]),
        agents: [{ id: "ada", name: "Ada" }, { id: "bo", name: "Bo" }],
        nowMs,
    });
    const byType = new Map(live.liveEvents.map((e) => [e.type, e]));
    assert.equal(byType.get("handoff")?.actorKey, "agent:ada");
    assert.equal(byType.get("handoff")?.targetKey, "agent:bo");
    assert.equal(byType.get("task_done")?.actorKey, "agent:bo");
    assert.equal(byType.get("needs_you")?.title, "Approve Publish post");
    assert.equal(new Set(live.liveEvents.map((e) => e.id)).size, live.liveEvents.length);
});

test("pending approvals are deduplicated across task links", () => {
    const base = { requesterAgentId: null, actionType: "spend", rationale: "Buy credits", requestedAt: NOW, taskInput: null, taskType: null };
    assert.equal(pendingApprovalRows([{ id: "a", ...base }, { id: "a", ...base }, { id: "b", ...base }]).length, 2);
});

test("desk columns: five per row beside the inbox at 1280px, eight at most", () => {
    assert.equal(deskColumns(150), 2);
    assert.equal(deskColumns(309), 3);
    assert.equal(deskColumns(534), 5);
    assert.equal(deskColumns(1164), 8);
    assert.equal(deskColumns(3000), 8);
});
