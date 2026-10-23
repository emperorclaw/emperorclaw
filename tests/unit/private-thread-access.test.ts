import test from "node:test";
import assert from "node:assert/strict";
import { agentTokenMayUseThread, eventThreadIds, isPrivateDirectThread, mostRestrictiveAudience, socketMayReceive, userMayUseThread } from "../../src/lib/direct-chat-mode";
import { parseRealtimeNotification, socketReceives } from "../../src/lib/realtime-delivery";

const privateThread = { type: "direct", ownerUserId: "ua", isPrivate: true, directAgentId: "ax" };
const orphan = { type: "direct", ownerUserId: null, isPrivate: true, directAgentId: "ax" };
const operations = { type: "direct", ownerUserId: null, isPrivate: false, directAgentId: "ax" };

test("isPrivateDirectThread: owned or flagged direct threads only", () => {
    assert.ok(isPrivateDirectThread(privateThread));
    assert.ok(isPrivateDirectThread(orphan));
    assert.ok(!isPrivateDirectThread(operations));
    assert.ok(!isPrivateDirectThread({ type: "team" }));
});

test("userMayUseThread: owner only, an orphan nobody, shared threads everyone", () => {
    assert.ok(userMayUseThread(privateThread, "ua"));
    assert.ok(!userMayUseThread(privateThread, "ub"));
    assert.ok(!userMayUseThread(orphan, "ub"));
    assert.ok(!userMayUseThread(orphan, null));
    assert.ok(userMayUseThread(operations, "ub"));
});

test("agentTokenMayUseThread: only a token bound to the thread's agent", () => {
    assert.ok(agentTokenMayUseThread(privateThread, "ax"));
    assert.ok(!agentTokenMayUseThread(privateThread, "ay"));
    assert.ok(!agentTokenMayUseThread(privateThread, null), "unbound tokens never");
    assert.ok(agentTokenMayUseThread(operations, null));
});

test("eventThreadIds lists every thread a payload names", () => {
    assert.deepEqual(eventThreadIds({ thread: { id: "t1" } }), ["t1"]);
    assert.deepEqual(eventThreadIds({ threadId: "t2" }), ["t2"]);
    assert.deepEqual(eventThreadIds({ message: { threadId: "t3" } }), ["t3"]);
    assert.deepEqual(eventThreadIds({ objective: { threadId: "t4" } }), ["t4"]);
    assert.deepEqual(eventThreadIds({ thread: { id: "team" }, message: { threadId: "priv" } }), ["team", "priv"]);
    assert.deepEqual(eventThreadIds({ type: "task_updated" }), []);
});

test("mostRestrictiveAudience: any private thread wins; mixed private agents reach nobody", () => {
    const team = { type: "team" };
    assert.equal(mostRestrictiveAudience([team, operations]), null);
    assert.deepEqual(mostRestrictiveAudience([team, privateThread]), { agentId: "ax" });
    assert.deepEqual(mostRestrictiveAudience([privateThread, { ...privateThread, directAgentId: "ay" }]), { agentId: null });
});

test("realtime fan-out: audience events go to the bound agent only", () => {
    assert.ok(socketMayReceive(null, { agentId: null }));
    assert.ok(socketMayReceive({ agentId: "ax" }, { agentId: "ax" }));
    assert.ok(!socketMayReceive({ agentId: "ax" }, { agentId: "ay" }));
    assert.ok(!socketMayReceive({ agentId: null }, { agentId: null }));
    const n = parseRealtimeNotification(JSON.stringify({ companyId: "c", audience: { agentId: "ax" }, payload: { type: "thread_message" } }))!;
    assert.equal(n.message, JSON.stringify({ type: "thread_message" }));
    assert.ok(socketReceives(n, { companyId: "c", agentId: "ax" }));
    assert.ok(!socketReceives(n, { companyId: "c", agentId: "ay" }));
    assert.ok(!socketReceives(n, { companyId: "other", agentId: "ax" }));
});
