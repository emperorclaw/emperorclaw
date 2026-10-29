import { test } from "node:test";
import assert from "node:assert/strict";
import {
    LATEST_HERMES_BRIDGE_VERSION,
    MIN_HERMES_BRIDGE_VERSION,
    PINNED_HERMES_VERSION,
    bridgeUpdateState,
    hermesBridgeInfo,
    normalizeBridgeVersion,
} from "../../src/lib/hermes-bridge-version";

test("register advertises the latest, minimum and pinned Hermes versions", () => {
    assert.deepEqual(hermesBridgeInfo(), {
        latest: LATEST_HERMES_BRIDGE_VERSION,
        minimum: MIN_HERMES_BRIDGE_VERSION,
        hermes: PINNED_HERMES_VERSION,
        deprecated: ["0.3"],
    });
    assert.equal(PINNED_HERMES_VERSION, "v0.22.4");
});

test("a node without a bridge version is a legacy 0.3.x bridge", () => {
    assert.equal(bridgeUpdateState({ bridgeVersion: null }), "legacy");
    assert.equal(bridgeUpdateState({}), "legacy");
    assert.equal(bridgeUpdateState({ bridgeVersion: "  " }), "legacy");
});

test("versions map to current, update-available and unsupported", () => {
    assert.equal(bridgeUpdateState({ bridgeVersion: "0.21.0" }), "current");
    assert.equal(bridgeUpdateState({ bridgeVersion: "v0.21.0" }), "current");
    assert.equal(bridgeUpdateState({ bridgeVersion: "0.3.0" }), "unsupported");
    assert.equal(bridgeUpdateState({ bridgeVersion: "garbage" }), "unsupported");
    // With a newer latest, a supported older bridge has an update available.
    assert.equal(bridgeUpdateState({ bridgeVersion: "0.9.0" }, "0.9.3", "0.9.0"), "update-available");
    assert.equal(bridgeUpdateState({ bridgeVersion: "0.8.9" }, "0.9.3", "0.9.0"), "unsupported");
});

test("normalizeBridgeVersion strips a v prefix and pre-release suffix", () => {
    assert.equal(normalizeBridgeVersion("v0.9.0"), "0.9.0");
    assert.equal(normalizeBridgeVersion("0.9.0-rc.1"), "0.9.0");
    assert.equal(normalizeBridgeVersion("1.2"), "1.2.0");
    assert.equal(normalizeBridgeVersion("hermes-agent"), null);
});
