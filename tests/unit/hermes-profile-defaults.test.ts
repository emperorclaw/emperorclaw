import assert from "node:assert/strict";
import test from "node:test";
import {
    HERMES_CONFIG_DEFAULTS_ENV, HERMES_PROFILE_CONFIG_DEFAULTS, hermesConfigDefaultsEnvValue,
} from "../../src/lib/hermes-profile-defaults";

test("new Hermes profiles get the fast-path config defaults", () => {
    const defaults = new Map(HERMES_PROFILE_CONFIG_DEFAULTS);
    assert.equal(defaults.get("compression.threshold_tokens"), "80000");
    assert.equal(defaults.get("compression.proactive_prune_tokens"), "48000");
    assert.equal(defaults.get("compression.idle_compact_after_seconds"), "0");
    assert.equal(defaults.get("approvals.single_query_mode"), "approve");
    assert.equal(defaults.get("tools.tool_search.enabled"), "off");
    assert.equal(defaults.size, HERMES_PROFILE_CONFIG_DEFAULTS.length, "keys must be unique so re-applying is idempotent");
});

test("defaults serialize as one key=value line each", () => {
    assert.equal(HERMES_CONFIG_DEFAULTS_ENV, "EMPEROR_CLAW_HERMES_CONFIG_DEFAULTS");
    const lines = hermesConfigDefaultsEnvValue().split("\n");
    assert.equal(lines.length, HERMES_PROFILE_CONFIG_DEFAULTS.length);
    assert.ok(lines.includes("compression.threshold_tokens=80000"));
    assert.ok(lines.includes("tools.tool_search.enabled=off"));
    // Same input, same output: safe to apply on every container start.
    assert.equal(hermesConfigDefaultsEnvValue(), hermesConfigDefaultsEnvValue());
});

test("keys or values that would break the line format are rejected", () => {
    assert.throws(() => hermesConfigDefaultsEnvValue([["a=b", "1"]]));
    assert.throws(() => hermesConfigDefaultsEnvValue([["a b", "1"]]));
    assert.throws(() => hermesConfigDefaultsEnvValue([["a", "1\n2"]]));
    assert.equal(hermesConfigDefaultsEnvValue([["a.b", "x=y"]]), "a.b=x=y");
});
