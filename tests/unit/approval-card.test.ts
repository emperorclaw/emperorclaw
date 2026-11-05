import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalCardIdOf, approvalCardLabel, approvalCardText, neutralCardLine } from "../../src/lib/approval-card-copy";
import { RESERVED_MESSAGE_METADATA_KEYS, decideDelivery, stripReservedMetadata } from "../../src/lib/message-routing";
import { eventTopicsFor } from "../../src/lib/realtime-topics";

const APPROVAL_ID = "11111111-2222-4333-8444-555555555555";

test("the card label is the task title, with the action for anything but closing it", () => {
    assert.equal(approvalCardLabel({ actionType: "task_done", actionLabel: "task done", taskTitle: "Ship the landing page" }), "Ship the landing page");
    assert.equal(approvalCardLabel({ actionType: "send_email", actionLabel: "Send email", taskTitle: "Proposal" }), "Send email: Proposal");
    assert.equal(approvalCardLabel({ actionType: "spend_money", actionLabel: "Spend money", taskTitle: null }), "Spend money");
});

test("card text is one neutral line: no mention, no line breaks, bounded", () => {
    const text = approvalCardText("@Builder", approvalCardLabel({ actionType: "task_done", actionLabel: "x", taskTitle: "Ask @Tester\nto review" }));
    assert.equal(text, "Approval requested by Builder: Ask Tester to review");
    assert.equal(approvalCardText(null, "Deploy"), "Approval requested by an agent: Deploy");
    const long = neutralCardLine("a".repeat(500));
    assert.ok(long.length <= 120);
    assert.ok(long.endsWith("…"));
});

test("only a system message is an approval card", () => {
    const metadataJson = { approvalCard: { approvalId: APPROVAL_ID } };
    assert.equal(approvalCardIdOf({ senderType: "system", metadataJson }), APPROVAL_ID);
    assert.equal(approvalCardIdOf({ senderType: "agent", metadataJson }), null, "a forged agent message never renders a card");
    assert.equal(approvalCardIdOf({ senderType: "human", metadataJson }), null);
    assert.equal(approvalCardIdOf({ senderType: "system", metadataJson: { approvalCard: true } }), null);
    assert.equal(approvalCardIdOf({ senderType: "system", metadataJson: { approvalCard: { approvalId: "not-a-uuid" } } }), null);
    assert.equal(approvalCardIdOf({ senderType: "system", metadataJson: null }), null);
});

test("approval card keys are reserved metadata", () => {
    for (const key of ["approvalCard", "approvalDecision", "approvalDecisionFor"]) {
        assert.ok((RESERVED_MESSAGE_METADATA_KEYS as readonly string[]).includes(key), key);
    }
    assert.deepEqual(stripReservedMetadata({ approvalCard: { approvalId: APPROVAL_ID }, approvalDecisionFor: "x", keep: 1 }), { keep: 1 });
});

test("a card (system, untargeted) wakes no agent, even in its direct thread", () => {
    const message = { id: "m1", senderType: "system", senderId: null, targetAgentId: null, text: "Approval requested by Builder: Ship it", metadataJson: { approvalCard: { approvalId: APPROVAL_ID } } };
    const roster = [{ id: "a1", name: "Builder" }];
    for (const threadType of ["direct", "team", "group"]) {
        assert.equal(decideDelivery({ agentId: "a1", message, threadType, roster, agentStreak: 0 }).addressedToYou, false, threadType);
    }
});

test("approval events refresh that approval's card topic", () => {
    const topics = eventTopicsFor({ type: "approval_updated", approval: { id: APPROVAL_ID } }, null);
    assert.ok(topics.includes(`approval:${APPROVAL_ID}`));
    assert.ok(topics.includes("inbox"));
});
