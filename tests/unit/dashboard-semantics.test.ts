import assert from "node:assert/strict";
import test from "node:test";
import { dashboardFixture } from "../fixtures/dashboard";
import { dashboardActivity, deriveSceneAgents, filterDashboardBoard, kpiCounts, requiresHumanAction, sceneStatus, snapshotFreshness } from "../../src/lib/team-scene";
import { scoreAgent } from "../../src/lib/agent-health";
import { agentHue } from "../../src/lib/live-feed";
import { resolveAppearance } from "../../src/lib/character/model";

const now = new Date("2026-10-08T12:00:00.000Z");
const data = dashboardFixture(60, now.toISOString());

test("an active agent keeps working while an approval and late notice are pending", () => {
    const agent = deriveSceneAgents(data).find((a) => a.member.id === "fixture-0")!;
    assert.equal(agent.status, "working");
    assert.equal(agent.notices?.filter(requiresHumanAction).length, 2);
    assert.equal(agent.behavior.kind, "typing");
    assert.equal(kpiCounts(deriveSceneAgents(data), data).attention, data.attention.filter(requiresHumanAction).length);
});

test("agent response delays are watch signals; failed delivery can require intervention", () => {
    const message = data.attention.find((entry) => entry.kind === "message")!;
    assert.equal(requiresHumanAction(message), false);
    assert.equal(requiresHumanAction({ ...message, actionRequired: true }), true);
    const member = data.members[4];
    assert.equal(sceneStatus(member, message), "working");
    assert.equal(deriveSceneAgents(data).find((a) => a.member.id === member.id)?.behavior.caption, "Task in progress");
});

test("an incident in one task does not stop unrelated assigned work", () => {
    const member = data.members[0];
    const incident = { ...data.attention[0], kind: "incident" as const, taskId: "another-task" };
    assert.equal(sceneStatus({ ...member, activity: null }, incident), "working");
    assert.equal(sceneStatus({ ...member, activity: null }, { ...incident, taskId: member.working[0].id }), "blocked");
    assert.equal(sceneStatus({ ...member, health: "down" }, incident), "working", "fresh runtime activity wins over cached health");
});

test("offline history without outstanding issues is not an attention warning", () => {
    assert.deepEqual(scoreAgent({ online: false, unanswered: 0, failed: 0, overdueTasks: 0, budgetStatus: "active", requests: 99, replies: 99 }), { status: "idle", reasons: [] });
});

test("board filters choose task states and include human and unassigned work", () => {
    const humanTask = { ...data.board.inProgress[0], id: "human-task", assigneeKey: "human:owner" };
    const unassigned = { ...humanTask, id: "unassigned-task", assigneeKey: null };
    const board = { ...data.board, inProgress: [...data.board.inProgress, humanTask, unassigned] };
    const filters = { kpi: "working" as const, query: "", zoneFilter: null, members: data.members };
    const result = filterDashboardBoard(board, filters);
    assert.equal(result.inProgress.length, board.inProgress.length);
    assert.equal(result.review.length, 0);
    assert.equal(result.done.length, 0);
    const done = filterDashboardBoard(board, { ...filters, kpi: "done" });
    assert.deepEqual(done.done, board.done);
    assert.equal(done.inProgress.length, 0);
    assert.equal(filterDashboardBoard(board, { ...filters, query: "missing project" }).inProgress.length, 0);
});

test("snapshot staleness and offline state do not claim live updates", () => {
    assert.equal(snapshotFreshness(now.toISOString(), now), "current");
    assert.equal(snapshotFreshness(new Date(now.getTime() - 46_000).toISOString(), now), "stale");
    assert.equal(snapshotFreshness(now.toISOString(), now, false), "offline");
    assert.equal(snapshotFreshness("invalid", now), "stale");
});

test("ESP32 feed uses the web avatar palette, including customized appearances", () => {
    for (const member of data.members) {
        assert.equal(agentHue(member.id, member), resolveAppearance({ ...member }).hue);
    }
    assert.equal(agentHue("custom", { avatarAppearance: { ...resolveAppearance({ id: "custom" }), hue: 200 } }), 200);
});

test("quiet availability is the default; idle character routines are explicitly optional", () => {
    const idle = deriveSceneAgents(data).find((a) => a.member.id === "fixture-6")!;
    assert.equal(idle.behavior.kind, "available");
    assert.equal(idle.behavior.caption, "Available");
    assert.ok(["nap", "coffee", "stretch"].includes(deriveSceneAgents(data, true).find((a) => a.member.id === "fixture-6")!.behavior.kind));
});

test("the company dashboard masks private chat activity but preserves shared work", () => {
    assert.equal(dashboardActivity("Discussing a confidential acquisition", "direct"), "Working in a private chat");
    assert.equal(dashboardActivity("Writing the launch brief", "team"), "Writing the launch brief");
    assert.equal(dashboardActivity(null, "group"), "Working…");
});
