import test from "node:test";
import assert from "node:assert/strict";
import { controlScopeFor, parseRuntimeTraits } from "@/lib/agent-control";

const own = { ownerUserId: "user-a" };
const shared = { ownerUserId: null };

test("controlScopeFor: kill is thread-scoped only in an owned chat on a thread-kill runtime", () => {
    assert.equal(controlScopeFor("kill", own, { threadKill: true }), "thread");
    assert.equal(controlScopeFor("kill", own, { threadKill: false }), "agent", "older runtime: agent-wide fallback");
    assert.equal(controlScopeFor("kill", own), "agent");
    assert.equal(controlScopeFor("kill", shared, { threadKill: true }), "agent", "shared/Operations thread");
    assert.equal(controlScopeFor("kill", own, { threadKill: true, agentWide: true }), "agent", "explicit agent-wide Stop");
});

test("controlScopeFor: replace keeps its 0.9.3 behaviour; queue is never scoped", () => {
    assert.equal(controlScopeFor("replace", own), "thread");
    assert.equal(controlScopeFor("replace", shared), "agent");
    assert.equal(controlScopeFor("replace", own, { agentWide: true }), "agent");
    assert.equal(controlScopeFor("queue", own, { threadKill: true }), "agent");
});

test("parseRuntimeTraits reads thread-kill-v1 and max-parallel-turns from capabilitiesJson", () => {
    assert.deepEqual(parseRuntimeTraits(["hermes-agent", "thread-kill-v1", "max-parallel-turns: 3"]),
        { threadKill: true, maxParallelTurns: 3 });
    assert.deepEqual(parseRuntimeTraits(["hermes-agent"]), { threadKill: false, maxParallelTurns: null });
    assert.deepEqual(parseRuntimeTraits(null), { threadKill: false, maxParallelTurns: null });
    assert.deepEqual(parseRuntimeTraits(["max-parallel-turns: 0", { maxParallelTurns: 4 }]), { threadKill: false, maxParallelTurns: null },
        "invalid or non-string entries are ignored");
    assert.equal(parseRuntimeTraits(["max-parallel-turns:1"]).maxParallelTurns, 1);
});
