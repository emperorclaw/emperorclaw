import { test } from "node:test";
import assert from "node:assert/strict";
import { agentProviders, getProvider } from "../../src/lib/agent-providers";

test("Hermes is the sole supported local runtime", () => {
    assert.deepEqual(agentProviders.filter(p => p.supportsLocal).map(p => p.id), ["hermes"]);
    assert.equal(getProvider("hermes")?.status, "available");
    assert.equal(getProvider("mcp")?.status, "available");
    assert.equal(getProvider("openclaw")?.status, "available");
});
