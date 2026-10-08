import assert from "node:assert/strict";
import test from "node:test";
import {
    attentionUrgency, classifyIncident, deriveSceneAgents, isIncidentStale, activityText, deriveBehavior,
    type AttentionEntry, type DashboardMember, type DashboardTask,
} from "../../src/lib/team-scene";

const task = (state: string, title = "Fix login"): DashboardTask => ({
    id: `${state}-${title}`, projectId: "p1", projectName: "Launch", title, state, taskType: null, assigneeKey: "agent:a1", updatedAt: "2026-10-07T10:00:00.000Z", dueAt: null,
});

const member = (overrides: Partial<DashboardMember> = {}): DashboardMember => ({
    key: "agent:a1", kind: "agent", id: "a1", name: "Growth", role: "Content Specialist", avatarUrl: null, skills: [],
    health: "healthy", healthReasons: [], activity: null, href: "/agents?agent=a1", createdAt: null, doneToday: 0, working: [], waiting: [], next: [],
    spendTodayCents: 0, monthlyCostCents: 0, monthlyBudgetCents: 0, lastActivityAt: null,
    ...overrides,
});

const attn = (kind: AttentionEntry["kind"], overrides: Partial<AttentionEntry> = {}): AttentionEntry => ({
    id: `x:${kind}`, kind, title: "Fix login", memberKey: "agent:a1", memberName: "Growth", area: "Launch",
    at: "2026-10-07T09:00:00.000Z", actionLabel: "Go", href: "/", ...overrides,
});

test("incidents classify from their structured reason code", () => {
    assert.equal(classifyIncident("sla_breach"), "late");
    assert.equal(classifyIncident("unclaimed_stale"), "not_started");
    assert.equal(classifyIncident("max_retries_exceeded"), "problem");
    assert.equal(classifyIncident("tool_failure"), "problem");
    // Fallback discriminator when the structured field is absent.
    assert.equal(classifyIncident(null, "Task x breached SLA deadline."), "late");
    assert.equal(classifyIncident("", "unclaimed in inbox for over 1 hour"), "not_started");
});

test("stale incidents are ignored: finished, claimed, or reassigned", () => {
    // late: task done → stale
    assert.equal(isIncidentStale({ classification: "late", taskState: "done", incidentCreatedAt: "2026-10-07T09:00:00.000Z", currentAssignmentAt: null }), true);
    // late: task still in progress → live
    assert.equal(isIncidentStale({ classification: "late", taskState: "in_progress", incidentCreatedAt: "2026-10-07T09:00:00.000Z", currentAssignmentAt: null }), false);
    // not_started: task claimed → stale
    assert.equal(isIncidentStale({ classification: "not_started", taskState: "in_progress", incidentCreatedAt: "2026-10-07T09:00:00.000Z", currentAssignmentAt: null }), true);
    assert.equal(isIncidentStale({ classification: "not_started", taskState: "inbox", incidentCreatedAt: "2026-10-07T09:00:00.000Z", currentAssignmentAt: null }), false);
    // problem: done → stale; failed still needs a human → live; no task → live
    assert.equal(isIncidentStale({ classification: "problem", taskState: "done", incidentCreatedAt: "2026-10-07T09:00:00.000Z", currentAssignmentAt: null }), true);
    assert.equal(isIncidentStale({ classification: "problem", taskState: "failed", incidentCreatedAt: "2026-10-07T09:00:00.000Z", currentAssignmentAt: null }), false);
    assert.equal(isIncidentStale({ classification: "problem", taskState: null, incidentCreatedAt: "2026-10-07T09:00:00.000Z", currentAssignmentAt: null }), false);
    // reassigned since the incident was created → stale
    assert.equal(isIncidentStale({ classification: "late", taskState: "in_progress", incidentCreatedAt: "2026-10-07T09:00:00.000Z", currentAssignmentAt: "2026-10-07T10:00:00.000Z" }), true);
});

test("SLA late but still working is not stuck — it keeps the working status", () => {
    const data = {
        members: [member({ working: [task("in_progress")] })],
        attention: [attn("late")],
        activity: [],
        generatedAt: "2026-10-07T12:00:00.000Z",
    };
    const agents = deriveSceneAgents(data);
    assert.equal(agents[0].status, "working");
    assert.equal(agents[0].behavior.caption, "Running late on Fix login");
    assert.equal(agents[0].behavior.kind, "typing", "keeps the working animation");
});

test("a queued-but-unclaimed task shows as an amber has-not-started note", () => {
    const data = {
        members: [member({ next: [task("inbox")] })],
        attention: [attn("not_started")],
        activity: [],
        generatedAt: "2026-10-07T12:00:00.000Z",
    };
    const agents = deriveSceneAgents(data);
    assert.equal(agents[0].status, "idle");
    assert.equal(agents[0].behavior.caption, "Hasn't started Fix login");
});

test("a real problem is the only stuck state", () => {
    const data = {
        members: [member({ working: [task("in_progress")] })],
        attention: [attn("incident", { reason: "max retries exceeded" })],
        activity: [],
        generatedAt: "2026-10-07T12:00:00.000Z",
    };
    const agents = deriveSceneAgents(data);
    assert.equal(agents[0].status, "blocked");
    assert.equal(agents[0].behavior.caption, "Stuck: Max retries exceeded");
});

test("health attention alone surfaces a check-in hint, not stuck", () => {
    const data = {
        members: [member({ health: "attention", healthReasons: ["2 unanswered messages"], working: [task("in_progress")] })],
        attention: [],
        activity: [],
        generatedAt: "2026-10-07T12:00:00.000Z",
    };
    const agents = deriveSceneAgents(data);
    assert.equal(agents[0].status, "working");
    assert.equal(agents[0].behavior.caption, "2 unanswered messages");
});

test("reassignment clears late/not_started but never a problem", () => {
    const reassigned = { incidentCreatedAt: "2026-10-07T09:00:00.000Z", currentAssignmentAt: "2026-10-07T10:00:00.000Z" };
    // A watchdog "late"/"not_started" predating the current assignment is stale.
    assert.equal(isIncidentStale({ classification: "late", taskState: "in_progress", ...reassigned }), true);
    assert.equal(isIncidentStale({ classification: "not_started", taskState: "inbox", ...reassigned }), true);
    // A "problem" is about the task itself: reassigning must not hide a failed task.
    assert.equal(isIncidentStale({ classification: "problem", taskState: "failed", ...reassigned }), false);
    // A cancelled (deleted) task clears a problem.
    assert.equal(isIncidentStale({ classification: "problem", taskState: "failed", incidentCreatedAt: "2026-10-07T09:00:00.000Z", currentAssignmentAt: null, taskDeleted: true }), true);
});

test("activity copy carries the truthful late / not-started captions", () => {
    assert.equal(activityText(member(), "working", attn("late")), "Running late on Fix login");
    assert.equal(activityText(member(), "idle", attn("not_started")), "Hasn't started Fix login");
    assert.equal(activityText(member(), "blocked", attn("incident", { reason: "tool failure" })), "Stuck: Tool failure");
    const kb = (attention: AttentionEntry | null) => deriveBehavior({ status: "working", activity: "x", memberKey: "agent:a1", attention, taskType: null, idleRoutine: null }).kind;
    assert.equal(kb(attn("late")), "typing", "late does not change the working animation");
});

test("urgency orders stuck before late before approval before replies before not-started", () => {
    const order = ["incident", "late", "approval", "message", "not_started"].map((k) => attentionUrgency(k as AttentionEntry["kind"]));
    for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i]);
});
