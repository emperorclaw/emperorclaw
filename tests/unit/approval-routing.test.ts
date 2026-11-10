import { test } from "node:test";
import assert from "node:assert/strict";
import { isActionKey } from "../../src/lib/action-policy";
import {
    activeApproverSteps, agentDeciders, agentsAbove, approvalActionKey, approverColumns, humanMayDecide, isAssignedToHuman,
    clampEscalateAfterMinutes, mayAgentApprove, nextEscalationLevel, normalizeActionType, normalizeApproverSetting, normalizeCompanyApprovalSettings, parseApproverSetting,
    parseEscalateAfterMinutes, resolveApproverChain, sanitizeApproverSetting, waitingOnText, waitingOnTextForAgent,
    type AgentAuthority, type ApproverSetting, type ChartLookup, type ChartRef,
} from "../../src/lib/approval-routing";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WORKER = id(1);
const LEAD = id(2);
const CTO = id(3);
const PEER = id(4);
const SUB = id(5);
const JOSE = id(10);
const LUIS = id(11);
const OWNER = id(12);
const ADMIN = id(13);

/** worker → lead → cto → Jose (human); peer → lead; sub → worker. */
function chartOf(lines: Record<string, ChartRef[]>): ChartLookup {
    return { managerOf: (agentId) => lines[agentId]?.[0] ?? null, managersOf: (agentId) => lines[agentId] ?? [] };
}
const agent = (agentId: string): ChartRef => ({ kind: "agent", id: agentId });
const human = (userId: string): ChartRef => ({ kind: "human", id: userId });
const CHART = chartOf({
    [WORKER]: [agent(LEAD)],
    [PEER]: [agent(LEAD)],
    [SUB]: [agent(WORKER)],
    [LEAD]: [agent(CTO)],
    [CTO]: [human(JOSE)],
});
const MEMBERS = new Set([JOSE, LUIS, OWNER, ADMIN]);

/** Authority as the server computes it, with a configurable "lacks the permission" set. */
function authorityFor(requester: string, chart: ChartLookup, denied: ReadonlySet<string> = new Set(), mutual: ReadonlySet<string> = new Set()) {
    const requesterAbove = agentsAbove(requester, chart);
    return (approver: string, explicit: boolean): AgentAuthority => mayAgentApprove({
        approverAgentId: approver,
        requesterAgentId: requester,
        requesterAbove,
        approverAbove: agentsAbove(approver, chart),
        approverLive: true,
        explicit,
        mutualExplicit: mutual.has(approver),
        actionMode: denied.has(approver) ? "ask" : "allowed",
        projectAccess: true,
    });
}

function resolve(input: { requester?: string; agentSetting?: ApproverSetting; teamSetting?: ApproverSetting | null; chart?: ChartLookup; denied?: Set<string>; mutual?: Set<string>; ownerUserId?: string | null }) {
    const requester = input.requester ?? WORKER;
    const chart = input.chart ?? CHART;
    return resolveApproverChain({
        requesterAgentId: requester,
        agentSetting: input.agentSetting ?? { mode: "auto" },
        teamSetting: input.teamSetting ?? null,
        chart,
        authority: authorityFor(requester, chart, input.denied, input.mutual),
        ownerUserId: input.ownerUserId ?? null,
        memberUserIds: MEMBERS,
    });
}

test("a. approvers set on the agent win: people", () => {
    const { steps } = resolve({ agentSetting: { mode: "people", userIds: [LUIS] }, teamSetting: { mode: "agent", agentId: CTO } });
    assert.deepEqual(steps, [{ kind: "users", userIds: [LUIS], source: "agent_setting" }, { kind: "admins", source: "fallback" }]);
});

test("a. approvers set on the agent win: an agent above it, then up its chain", () => {
    const { steps } = resolve({ agentSetting: { mode: "agent", agentId: CTO } });
    assert.deepEqual(steps.map((s) => s.kind === "agent" ? s.agentId : s.kind === "users" ? s.userIds : s.kind), [CTO, [JOSE], "admins"]);
    assert.equal(steps[0].source, "agent_setting");
});

test("b. team approvers apply when the agent has none", () => {
    const { steps } = resolve({ teamSetting: { mode: "people", userIds: [JOSE, LUIS] } });
    assert.deepEqual(steps[0], { kind: "users", userIds: [JOSE, LUIS], source: "team_setting" });
});

test("c. without settings, the chart manager chain: lead → cto → Jose → admins", () => {
    const { steps } = resolve({});
    assert.deepEqual(steps, [
        { kind: "agent", agentId: LEAD, source: "org_chart" },
        { kind: "agent", agentId: CTO, source: "org_chart" },
        { kind: "users", userIds: [JOSE], source: "org_chart" },
        { kind: "admins", source: "fallback" },
    ]);
});

test("d. no chart: the agent's owner, then admins", () => {
    const { steps } = resolve({ chart: chartOf({}), ownerUserId: OWNER });
    assert.deepEqual(steps, [{ kind: "users", userIds: [OWNER], source: "agent_owner" }, { kind: "admins", source: "fallback" }]);
});

test("e. nothing at all: owners and admins", () => {
    assert.deepEqual(resolve({ chart: chartOf({}) }).steps, [{ kind: "admins", source: "fallback" }]);
    // An owner who left the company is not an approver.
    assert.deepEqual(resolve({ chart: chartOf({}), ownerUserId: id(99) }).steps, [{ kind: "admins", source: "fallback" }]);
});

test("a boss without the permission is skipped and the walk continues up its chain", () => {
    const { steps, skipped } = resolve({ denied: new Set([LEAD]) });
    assert.equal(steps[0].kind === "agent" && steps[0].agentId, CTO);
    assert.deepEqual(skipped, [{ agentId: LEAD, reason: "action_not_allowed" }]);
    const none = resolve({ denied: new Set([LEAD, CTO]) });
    assert.deepEqual(none.steps[0], { kind: "users", userIds: [JOSE], source: "org_chart" });
});

test("no self-approval: an agent set as its own approver is skipped", () => {
    const { steps, skipped } = resolve({ agentSetting: { mode: "agent", agentId: WORKER } });
    assert.ok(!steps.some((s) => s.kind === "agent" && s.agentId === WORKER));
    assert.equal(skipped[0].reason, "self");
});

test("an approver chosen explicitly needs no chart position; the chart walk above it does", () => {
    // Named by an owner or admin: that is the grant, even for a peer.
    const peer = resolve({ agentSetting: { mode: "agent", agentId: PEER } });
    assert.deepEqual(peer.steps[0], { kind: "agent", agentId: PEER, source: "agent_setting" });
    // Above it, the chart rule applies again: the lead is above the worker (chart-derived).
    assert.deepEqual(peer.steps[1], { kind: "agent", agentId: LEAD, source: "org_chart" });

    // No org chart at all: the explicit agent still approves.
    const noChart = resolve({ chart: chartOf({}), agentSetting: { mode: "agent", agentId: CTO } });
    assert.deepEqual(noChart.steps, [{ kind: "agent", agentId: CTO, source: "agent_setting" }, { kind: "admins", source: "fallback" }]);
    const team = resolve({ chart: chartOf({}), teamSetting: { mode: "agent", agentId: CTO } });
    assert.deepEqual(team.steps[0], { kind: "agent", agentId: CTO, source: "team_setting" });

    // Still: no self-approval, its own permission for the action, and no direct mutual pair.
    assert.equal(resolve({ chart: chartOf({}), agentSetting: { mode: "agent", agentId: WORKER } }).skipped[0].reason, "self");
    const denied = resolve({ chart: chartOf({}), agentSetting: { mode: "agent", agentId: CTO }, denied: new Set([CTO]) });
    assert.deepEqual(denied.skipped[0], { agentId: CTO, reason: "action_not_allowed" });
    const mutual = resolve({ chart: chartOf({}), agentSetting: { mode: "agent", agentId: CTO }, mutual: new Set([CTO]) });
    assert.deepEqual(mutual.skipped[0], { agentId: CTO, reason: "cycle" });
    assert.deepEqual(mutual.steps, [{ kind: "admins", source: "fallback" }]);
});

test("a reporting loop is refused and never walked twice", () => {
    // A hand-edited chart: A → B → A.
    const A = id(20);
    const B = id(21);
    const loop = chartOf({ [A]: [agent(B)], [B]: [agent(A)] });
    const { steps, skipped } = resolve({ requester: A, chart: loop });
    assert.ok(!steps.some((s) => s.kind === "agent"), "nobody in a loop approves");
    assert.deepEqual(skipped.map((s) => s.reason), ["cycle", "self"]);
    assert.deepEqual(steps, [{ kind: "admins", source: "fallback" }]);
});

test("mayAgentApprove: each rule", () => {
    const base = {
        approverAgentId: LEAD, requesterAgentId: WORKER, requesterAbove: new Set([LEAD, CTO]), approverAbove: new Set([CTO]),
        approverLive: true, actionMode: "allowed" as const, projectAccess: true,
    };
    assert.deepEqual(mayAgentApprove(base), { ok: true });
    assert.deepEqual(mayAgentApprove({ ...base, approverAgentId: WORKER }), { ok: false, reason: "self" });
    assert.deepEqual(mayAgentApprove({ ...base, requesterAgentId: null }), { ok: false, reason: "self" });
    assert.deepEqual(mayAgentApprove({ ...base, approverAgentId: PEER, approverAbove: new Set([LEAD, CTO]) }), { ok: false, reason: "not_above" });
    assert.deepEqual(mayAgentApprove({ ...base, approverAgentId: SUB, approverAbove: new Set([WORKER, LEAD, CTO]) }), { ok: false, reason: "not_above" });
    assert.deepEqual(mayAgentApprove({ ...base, approverAbove: new Set([WORKER]) }), { ok: false, reason: "cycle" });
    // Explicit: chart position does not matter; a mutual pair is a cycle.
    assert.deepEqual(mayAgentApprove({ ...base, approverAgentId: SUB, approverAbove: new Set([WORKER]), explicit: true }), { ok: true });
    assert.deepEqual(mayAgentApprove({ ...base, explicit: true, mutualExplicit: true }), { ok: false, reason: "cycle" });
    assert.deepEqual(mayAgentApprove({ ...base, approverAgentId: WORKER, explicit: true }), { ok: false, reason: "self" });
    assert.deepEqual(mayAgentApprove({ ...base, explicit: true, actionMode: "ask" }), { ok: false, reason: "action_not_allowed" });
    assert.deepEqual(mayAgentApprove({ ...base, explicit: true, projectAccess: false }), { ok: false, reason: "no_project_access" });
    assert.deepEqual(mayAgentApprove({ ...base, approverLive: false }), { ok: false, reason: "inactive" });
    assert.deepEqual(mayAgentApprove({ ...base, actionMode: "ask" }), { ok: false, reason: "action_not_allowed" });
    assert.deepEqual(mayAgentApprove({ ...base, actionMode: "off" }), { ok: false, reason: "action_not_allowed" });
    assert.deepEqual(mayAgentApprove({ ...base, actionMode: null }), { ok: true }, "closing a task is not a governed action");
    assert.deepEqual(mayAgentApprove({ ...base, projectAccess: false }), { ok: false, reason: "no_project_access" });
    assert.deepEqual(mayAgentApprove({ ...base, projectAccess: null }), { ok: true }, "an action ask has no project");
});

test("approvalActionKey maps request_approval actions onto governed actions and fails closed on unknown ones", () => {
    const key = (actionType: string, isAction = false) => approvalActionKey({ actionType }, isAction, isActionKey);
    assert.deepEqual(key("deploy", true), { key: "deploy" });
    assert.deepEqual(key("spend"), { key: "spend_money" });
    assert.deepEqual(key("Send Email"), { key: "send_email" }, "normalized: lowercase, spaces to _");
    assert.deepEqual(key("send-email"), { key: "send_email" });
    assert.deepEqual(key("publish"), { key: "post_social" });
    assert.deepEqual(key("run_shell"), { key: "run_shell" }, "a catalog key as is");
    assert.deepEqual(key("task_done"), { key: null }, "only the plain close needs no action permission");
    assert.deepEqual(key(" Task-Done "), { key: null });
    assert.equal(key("launch_rocket"), "unknown");
    assert.equal(key("wire_transfer"), "unknown");
    assert.equal(key("made_up", true), "unknown");
    assert.equal(normalizeActionType("  Delete  Data "), "delete_data");
    assert.deepEqual(mayAgentApprove({ approverAgentId: LEAD, requesterAgentId: WORKER, requesterAbove: new Set([LEAD]), approverAbove: new Set(), approverLive: true, actionMode: "unknown", projectAccess: true }),
        { ok: false, reason: "unknown_action" });
});

test("an unknown action skips every agent and reaches people", () => {
    const requesterAbove = agentsAbove(WORKER, CHART);
    const { steps } = resolveApproverChain({
        requesterAgentId: WORKER, agentSetting: { mode: "auto" }, teamSetting: null, chart: CHART, ownerUserId: null, memberUserIds: MEMBERS,
        authority: (approver) => mayAgentApprove({ approverAgentId: approver, requesterAgentId: WORKER, requesterAbove, approverAbove: agentsAbove(approver, CHART), approverLive: true, actionMode: "unknown", projectAccess: true }),
    });
    assert.deepEqual(steps, [{ kind: "users", userIds: [JOSE], source: "org_chart" }, { kind: "admins", source: "fallback" }]);
});

test("a setting that names only the requester falls through to the next level (team lead asking)", () => {
    // The team's approver is the lead, and the lead asks: the chart (cto → Jose) decides, not owners/admins.
    const lead = resolve({ requester: LEAD, teamSetting: { mode: "agent", agentId: LEAD } });
    assert.deepEqual(lead.steps.map((s) => s.kind === "agent" ? s.agentId : s.kind), [CTO, "users", "admins"]);
    assert.equal(lead.steps[0].source, "org_chart");
    // Its own setting naming itself falls through to the team's.
    const own = resolve({ requester: LEAD, agentSetting: { mode: "agent", agentId: LEAD }, teamSetting: { mode: "people", userIds: [LUIS] } });
    assert.deepEqual(own.steps[0], { kind: "users", userIds: [LUIS], source: "team_setting" });
    // People who can't approve (not eligible) fall through too.
    const nobody = resolve({ agentSetting: { mode: "people", userIds: [id(77)] } });
    assert.equal(nobody.steps[0].kind === "agent" && nobody.steps[0].agentId, LEAD);
});

test("who may decide: approvers reached so far, owners and admins always, legacy asks as before", () => {
    const steps = resolve({}).steps;
    const routed = { ...approverColumns(steps, 0), approverChainJson: steps };
    assert.deepEqual(agentDeciders(routed), [LEAD]);
    assert.equal(humanMayDecide(routed, { userId: JOSE, isOwnerOrAdmin: false }), false, "Jose's turn has not come");
    assert.equal(humanMayDecide(routed, { userId: ADMIN, isOwnerOrAdmin: true }), true, "admins override");
    assert.equal(isAssignedToHuman(routed, { userId: ADMIN, isOwnerOrAdmin: true }), false, "but it is not waiting on them");

    const atJose = { ...approverColumns(steps, 2), approverChainJson: steps };
    assert.equal(humanMayDecide(atJose, { userId: JOSE, isOwnerOrAdmin: false }), true);
    assert.equal(humanMayDecide(atJose, { userId: LUIS, isOwnerOrAdmin: false }), false);
    assert.deepEqual(agentDeciders(atJose), [LEAD, CTO], "escalation adds deciders, never removes them");
    assert.equal(activeApproverSteps(atJose).length, 3);

    const legacy = { approverKind: null };
    assert.equal(humanMayDecide(legacy, { userId: LUIS, isOwnerOrAdmin: false }), true);
    assert.equal(isAssignedToHuman(legacy, { userId: LUIS, isOwnerOrAdmin: false }), true);
});

test("escalation moves to the next step and skips agents that no longer qualify", () => {
    const steps = resolve({}).steps;
    assert.equal(nextEscalationLevel(steps, 0, () => true), 1);
    assert.equal(nextEscalationLevel(steps, 0, (agentId) => agentId !== CTO), 2);
    assert.equal(nextEscalationLevel(steps, steps.length - 1, () => true), null, "owners and admins are the top");
});

test("waiting-on text", () => {
    const names = { agent: (a: string) => (a === LEAD ? "Architect" : "Agent"), person: (p: string) => (p === JOSE ? "Jose" : "Luis") };
    assert.equal(waitingOnText({ kind: "agent", agentId: LEAD, source: "org_chart" }, names), "Architect (agent)");
    assert.equal(waitingOnText({ kind: "users", userIds: [JOSE, LUIS], source: "agent_setting" }, names), "Jose, Luis");
    assert.equal(waitingOnText({ kind: "admins", source: "fallback" }, names), "an owner or admin");
});

test("agents never learn who the people approvers are", () => {
    const agentName = (a: string) => (a === LEAD ? "Architect" : "Agent");
    assert.equal(waitingOnTextForAgent({ kind: "agent", agentId: LEAD, source: "org_chart" }, agentName), "Architect (agent)");
    assert.equal(waitingOnTextForAgent({ kind: "users", userIds: [JOSE, LUIS], source: "agent_setting" }, agentName), "a person");
    assert.equal(waitingOnTextForAgent({ kind: "admins", source: "fallback" }, agentName), "an owner or admin");
});

test("saved approvers who left are dropped from the form", () => {
    const options = { agents: [{ id: LEAD, name: "Architect" }], people: [{ id: JOSE, name: "Jose" }] };
    assert.deepEqual(sanitizeApproverSetting({ mode: "agent", agentId: CTO }, options), { value: { mode: "auto" }, cleared: true });
    assert.deepEqual(sanitizeApproverSetting({ mode: "people", userIds: [JOSE, LUIS] }, options), { value: { mode: "people", userIds: [JOSE] }, cleared: true });
    assert.deepEqual(sanitizeApproverSetting({ mode: "people", userIds: [LUIS] }, options), { value: { mode: "auto" }, cleared: true });
    assert.deepEqual(sanitizeApproverSetting({ mode: "agent", agentId: LEAD }, options), { value: { mode: "agent", agentId: LEAD }, cleared: false });
});

test("settings parse strictly and normalize leniently", () => {
    assert.deepEqual(parseApproverSetting({ mode: "auto" }), { setting: { mode: "auto" } });
    assert.deepEqual(parseApproverSetting({ mode: "agent", agentId: LEAD }), { setting: { mode: "agent", agentId: LEAD } });
    assert.ok("error" in parseApproverSetting({ mode: "agent", agentId: "Builder" }));
    assert.ok("error" in parseApproverSetting({ mode: "people", userIds: [] }));
    assert.ok("error" in parseApproverSetting({ mode: "boss" }));
    assert.deepEqual(normalizeApproverSetting({ mode: "people", userIds: [JOSE, JOSE, "x"] }), { mode: "people", userIds: [JOSE] });
    assert.deepEqual(normalizeApproverSetting("garbage"), { mode: "auto" });

    assert.deepEqual(parseEscalateAfterMinutes(45), { minutes: 45 });
    assert.ok("error" in parseEscalateAfterMinutes(2));
    assert.ok("error" in parseEscalateAfterMinutes(12.5));
    assert.equal(normalizeCompanyApprovalSettings({}).escalateAfterMinutes, 30);
    assert.equal(normalizeCompanyApprovalSettings({ escalateAfterMinutes: 1 }).escalateAfterMinutes, 5, "clamped, as in SQL");
    assert.equal(clampEscalateAfterMinutes("99999"), 1440);
    assert.equal(clampEscalateAfterMinutes(45), 45);
    assert.equal(clampEscalateAfterMinutes(-5), 30, "not digits: the default, as in SQL");
    assert.equal(clampEscalateAfterMinutes("12.5"), 30);
    assert.equal(clampEscalateAfterMinutes(null), 30);
    assert.deepEqual(normalizeCompanyApprovalSettings({ teamApprovers: { [id(30)]: { mode: "people", userIds: [JOSE] }, bad: { mode: "people", userIds: [JOSE] } } }).teamApprovers,
        { [id(30)]: { mode: "people", userIds: [JOSE] } });
});
