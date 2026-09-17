import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentControlCommand, validateAgentControl } from "../../src/lib/agent-control-command";

test("runtime commands recognize multiline prompts without intercepting ordinary messages", () => {
    assert.deepEqual(parseAgentControlCommand(" /KILL "), { action: "kill", prompt: "" });
    assert.deepEqual(parseAgentControlCommand("/queue Research\nthen summarize"), { action: "queue", prompt: "Research\nthen summarize" });
    assert.deepEqual(parseAgentControlCommand("/replace New goal"), { action: "replace", prompt: "New goal" });
    for (const text of ["please /kill", "/kill-agent", "/queueing", "hello"]) assert.equal(parseAgentControlCommand(text), null);
});
test("empty replacement and invalid stop arguments are rejected before changing state", () => {
    assert.ok(validateAgentControl("replace", " "));
    assert.ok(validateAgentControl("queue", ""));
    assert.ok(validateAgentControl("kill", "another agent"));
    assert.ok(validateAgentControl("delete", ""));
    assert.ok(validateAgentControl("replace", "x".repeat(32001)));
    assert.equal(validateAgentControl("kill", ""), null);
    assert.equal(validateAgentControl("queue", "next task"), null);
});
