// Who may decide an approval (lib/approval-routing.ts decisionBasis and friends):
// owners/admins, "Can decide any approval" people, the requesting agent's owner,
// then a routed ask's approvers. Everyone else reads it only, with a reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    MAX_DECIDER_PEOPLE, approvalAgentId, approvalHiddenByPrivateThread, approvalView, decisionBasis, decisionBlockReason, humanMayDecide, implicitTaskBlockReason, isAssignedToHuman,
    normalizeCompanyApprovalSettings, parseDeciderUserIds, type ApprovalViewer, type ApproverStep,
} from "../../src/lib/approval-routing";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AGENT = id(1);
const OTHER_AGENT = id(2);
const JOSE = id(10);
const LUIS = id(11);
const ADMIN = id(12);
const DECIDER = id(13);
const OWNER_OF_AGENT = id(14);

const member = (userId: string, extra: Partial<ApprovalViewer> = {}): ApprovalViewer => ({ userId, isOwnerOrAdmin: false, mayDecideAll: false, ownedAgentIds: new Set(), ...extra });
const admin = member(ADMIN, { isOwnerOrAdmin: true });
const decider = member(DECIDER, { mayDecideAll: true });
const agentOwner = member(OWNER_OF_AGENT, { ownedAgentIds: new Set([AGENT]) });
const plain = member(LUIS);

const unrouted = { approverKind: null, requesterAgentId: AGENT };
const chain: ApproverStep[] = [{ kind: "users", userIds: [JOSE], source: "org_chart" }, { kind: "admins", source: "fallback" }];
const routedToJose = { approverKind: "users", requesterAgentId: AGENT, approverChainJson: chain, escalationLevel: 0 };

test("an unrouted ask: only owners/admins, granted deciders and the agent's owner decide it", () => {
    assert.equal(humanMayDecide(unrouted, admin), true);
    assert.equal(humanMayDecide(unrouted, decider), true);
    assert.equal(humanMayDecide(unrouted, agentOwner), true);
    assert.equal(humanMayDecide(unrouted, plain), false, "a plain member no longer decides an unrouted ask");
    assert.equal(decisionBlockReason(unrouted, plain), "not_permitted");
    assert.equal(decisionBlockReason(unrouted, admin), null);
});

test("owning another agent grants nothing on this agent's asks", () => {
    const ownsOther = member(JOSE, { ownedAgentIds: new Set([OTHER_AGENT]) });
    assert.equal(humanMayDecide(unrouted, ownsOther), false);
    assert.equal(humanMayDecide({ approverKind: null, requesterAgentId: null }, ownsOther), false, "a token ask with no agent has no owner");
});

test("decisionBasis names the first matching reason, in order", () => {
    assert.equal(decisionBasis(unrouted, member(ADMIN, { isOwnerOrAdmin: true, mayDecideAll: true, ownedAgentIds: new Set([AGENT]) })), "admin");
    assert.equal(decisionBasis(unrouted, member(DECIDER, { mayDecideAll: true, ownedAgentIds: new Set([AGENT]) })), "decider");
    assert.equal(decisionBasis(unrouted, agentOwner), "agent_owner");
    assert.equal(decisionBasis(routedToJose, member(JOSE)), "approver");
    assert.equal(decisionBasis(routedToJose, plain), null);
});

test("a routed ask: its approvers decide; the overrides still decide; others wait", () => {
    assert.equal(humanMayDecide(routedToJose, member(JOSE)), true);
    assert.equal(humanMayDecide(routedToJose, plain), false);
    assert.equal(decisionBlockReason(routedToJose, plain), "waiting_on_other");
    assert.equal(humanMayDecide(routedToJose, agentOwner), true, "the agent's owner overrides");
    assert.equal(humanMayDecide(routedToJose, decider), true, "a granted decider overrides");
});

test("assignment: an unrouted ask waits on everyone who may decide it; overrides are not assignees of a routed ask", () => {
    assert.equal(isAssignedToHuman(unrouted, agentOwner), true);
    assert.equal(isAssignedToHuman(unrouted, decider), true);
    assert.equal(isAssignedToHuman(unrouted, plain), false);
    assert.equal(isAssignedToHuman(routedToJose, member(JOSE)), true);
    assert.equal(isAssignedToHuman(routedToJose, agentOwner), false);
    assert.equal(isAssignedToHuman(routedToJose, decider), false);
    assert.equal(isAssignedToHuman({ ...routedToJose, escalationLevel: 1 }, admin), true, "escalated to admins");
});

test("deciderUserIds: normalized when read, strict when sent", () => {
    assert.deepEqual(normalizeCompanyApprovalSettings({}).deciderUserIds, []);
    assert.deepEqual(normalizeCompanyApprovalSettings({ deciderUserIds: [JOSE, JOSE, "nope", 7, LUIS] }).deciderUserIds, [JOSE, LUIS]);
    assert.deepEqual(normalizeCompanyApprovalSettings({ deciderUserIds: "x" }).deciderUserIds, []);
    const many = Array.from({ length: MAX_DECIDER_PEOPLE + 5 }, (_, i) => id(100 + i));
    assert.equal(normalizeCompanyApprovalSettings({ deciderUserIds: many }).deciderUserIds.length, MAX_DECIDER_PEOPLE);

    assert.deepEqual(parseDeciderUserIds([JOSE, JOSE]), { userIds: [JOSE] });
    assert.deepEqual(parseDeciderUserIds([]), { userIds: [] }, "an empty list clears the grant");
    assert.ok("error" in parseDeciderUserIds("x"));
    assert.ok("error" in parseDeciderUserIds([JOSE, "nope"]));
    assert.ok("error" in parseDeciderUserIds(many));
});

test("a card in a private direct chat: visible to its owner and anyone with a decide basis, hidden from everyone else", () => {
    const privateChat = { type: "direct", ownerUserId: JOSE, isPrivate: true };
    assert.equal(approvalHiddenByPrivateThread(privateChat, plain, null), true);
    assert.equal(approvalHiddenByPrivateThread(privateChat, member(JOSE), null), false, "the chat's owner, even with no basis");
    assert.equal(approvalHiddenByPrivateThread(privateChat, agentOwner, "agent_owner"), false, "whoever may decide it can see it");
    assert.equal(approvalHiddenByPrivateThread(privateChat, admin, "admin"), false);
    assert.equal(approvalHiddenByPrivateThread({ type: "direct", ownerUserId: null, isPrivate: true }, plain, null), true, "an orphaned private chat belongs to nobody");
    assert.equal(approvalHiddenByPrivateThread({ type: "direct", ownerUserId: null, isPrivate: false }, plain, null), false, "a shared direct thread");
    assert.equal(approvalHiddenByPrivateThread({ type: "team", ownerUserId: null, isPrivate: false }, plain, null), false);
    assert.equal(approvalHiddenByPrivateThread(null, plain, null), false);
});

const pendingUnrouted = { ...unrouted, status: "pending" };
const open = { thread: null, inScope: true };

test("approvalView: one rule for visibility, decision and details", () => {
    assert.deepEqual(approvalView(pendingUnrouted, agentOwner, open), { visible: true, basis: "agent_owner", reason: null, mayDecide: true, mayReadDetails: true });
    assert.deepEqual(approvalView(pendingUnrouted, plain, open), { visible: true, basis: null, reason: "not_permitted", mayDecide: false, mayReadDetails: false });
    const routedOther = { ...routedToJose, status: "pending" };
    assert.deepEqual(approvalView(routedOther, plain, open), { visible: true, basis: null, reason: "waiting_on_other", mayDecide: false, mayReadDetails: true }, "as before routing, a member a routed ask waits on someone else for reads it");
    assert.equal(approvalView(pendingUnrouted, admin, { ...open, inScope: false }).visible, false, "out of scope");
});

test("approvalView: viewers, demoted approvers and Can-view members never decide", () => {
    const demoted = member(JOSE, { mayAct: false });
    const view = approvalView({ ...routedToJose, status: "pending" }, demoted, open);
    assert.equal(view.reason, "viewer", "a stored step naming a now-viewer grants nothing");
    assert.equal(view.mayDecide, false);
    assert.equal(view.mayReadDetails, false);
    const viewOnly = approvalView(pendingUnrouted, agentOwner, { ...open, viewOnly: true });
    assert.equal(viewOnly.reason, "view_only");
    assert.equal(viewOnly.mayDecide, false);
    assert.equal(viewOnly.mayReadDetails, false);
});

test("approvalView: a private-chat ask is hidden only from people with no part in it", () => {
    const thread = { type: "direct", ownerUserId: JOSE, isPrivate: true };
    assert.equal(approvalView(pendingUnrouted, plain, { thread, inScope: true }).visible, false);
    const ownerOfChat = approvalView(pendingUnrouted, member(JOSE), { thread, inScope: true });
    assert.equal(ownerOfChat.visible, true);
    assert.equal(ownerOfChat.reason, "not_permitted", "the chat's owner with no basis reads it only");
    assert.equal(ownerOfChat.mayReadDetails, false);
    assert.equal(approvalView(pendingUnrouted, agentOwner, { thread, inScope: true }).mayDecide, true, "the agent's owner sees and decides it in someone else's chat");
});

test("a decided ask: details only for those who had a basis", () => {
    const decided = { ...unrouted, status: "approved" };
    assert.equal(approvalView(decided, plain, open).mayReadDetails, false);
    assert.equal(approvalView(decided, plain, open).mayDecide, false);
    assert.equal(approvalView(decided, agentOwner, open).mayReadDetails, true);
});

test("implicit tasks: only those who could decide the resulting unrouted ask", () => {
    const task = { assignedAgentId: AGENT };
    assert.equal(implicitTaskBlockReason(task, plain, false), "not_permitted");
    assert.equal(implicitTaskBlockReason(task, agentOwner, false), null);
    assert.equal(implicitTaskBlockReason(task, decider, false), null);
    assert.equal(implicitTaskBlockReason(task, admin, false), null);
    assert.equal(implicitTaskBlockReason(task, agentOwner, true), "view_only");
    assert.equal(implicitTaskBlockReason(task, member(OWNER_OF_AGENT, { mayAct: false, ownedAgentIds: new Set([AGENT]) }), false), "viewer");
});

test("a person's ask on an agent's task: that agent's owner decides it", () => {
    const personAsk = { approverKind: null, requesterAgentId: null, metadataJson: { taskAgentId: AGENT } };
    assert.equal(approvalAgentId(personAsk), AGENT);
    assert.equal(decisionBasis(personAsk, agentOwner), "agent_owner");
    assert.equal(decisionBasis({ ...personAsk, metadataJson: {} }, agentOwner), null);
    assert.equal(approvalAgentId({ requesterAgentId: OTHER_AGENT, metadataJson: { taskAgentId: AGENT } }), OTHER_AGENT, "the requester wins");
});
