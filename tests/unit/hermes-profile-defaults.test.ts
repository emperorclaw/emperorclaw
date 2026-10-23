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
    assert.equal(defaults.get("tools.tool_search.enabled"), "off");
    assert.equal(defaults.size, HERMES_PROFILE_CONFIG_DEFAULTS.length, "keys must be unique so re-applying is idempotent");
});

test("0.9 runtime keys: approval and clarify backstops, restart drain, no title calls", () => {
    const defaults = new Map(HERMES_PROFILE_CONFIG_DEFAULTS);
    assert.equal(defaults.get("approvals.timeout"), "60");
    assert.equal(defaults.get("agent.restart_drain_timeout"), "30");
    assert.equal(defaults.get("agent.clarify_timeout"), "60");
    assert.equal(defaults.get("auxiliary.title_generation.enabled"), "false");
    // The CLI-only single-query mode is gone with the `hermes chat -q` path.
    assert.equal(defaults.has("approvals.single_query_mode"), false);
});

test("the drain fits inside the managed stop budget", () => {
    const drain = Number(new Map(HERMES_PROFILE_CONFIG_DEFAULTS).get("agent.restart_drain_timeout"));
    // The gateway exits ~20.5 s after its drain (measured on v0.22.4). That exit must land
    // before the supervisor's 55 s SIGKILL (systemd allows 70 s), with margin.
    assert.ok(drain > 0);
    assert.ok(drain + 20.5 + 3 <= 55, `drain ${drain} s would be SIGKILLed`);
});

test("no gateway topology keys: the entrypoint and installer own those per mode", () => {
    for (const [key] of HERMES_PROFILE_CONFIG_DEFAULTS) {
        assert.ok(!key.startsWith("gateway."), `${key} must not be a server default`);
    }
});

test("defaults serialize as one key=value line each", () => {
    assert.equal(HERMES_CONFIG_DEFAULTS_ENV, "EMPEROR_CLAW_HERMES_CONFIG_DEFAULTS");
    const lines = hermesConfigDefaultsEnvValue().split("\n");
    assert.equal(lines.length, HERMES_PROFILE_CONFIG_DEFAULTS.length);
    assert.ok(lines.includes("compression.threshold_tokens=80000"));
    assert.ok(lines.includes("tools.tool_search.enabled=off"));
    assert.ok(lines.includes("agent.restart_drain_timeout=30"));
    // Same input, same output: safe to apply on every container start.
    assert.equal(hermesConfigDefaultsEnvValue(), hermesConfigDefaultsEnvValue());
});

test("keys or values that would break the line format are rejected", () => {
    assert.throws(() => hermesConfigDefaultsEnvValue([["a=b", "1"]]));
    assert.throws(() => hermesConfigDefaultsEnvValue([["a b", "1"]]));
    assert.throws(() => hermesConfigDefaultsEnvValue([["a", "1\n2"]]));
    assert.equal(hermesConfigDefaultsEnvValue([["a.b", "x=y"]]), "a.b=x=y");
});
