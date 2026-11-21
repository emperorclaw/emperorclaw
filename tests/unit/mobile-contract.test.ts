import test from "node:test";
import assert from "node:assert/strict";
import { validMobileAuthorization, validMobileVerifier } from "../../src/lib/mobile-contract";

test("native authorization requires an S256 challenge, bounded state and a device label", () => {
    const valid = { challenge: "A".repeat(43), state: "B".repeat(43), deviceName: "iPhone" };
    assert.equal(validMobileAuthorization(valid), true);
    for (const change of [{ challenge: "" }, { challenge: "a/b".repeat(15) }, { state: "short" }, { state: "A".repeat(129) }, { deviceName: " " }, { deviceName: "A".repeat(81) }]) {
        assert.equal(validMobileAuthorization({ ...valid, ...change }), false);
    }
});

test("PKCE verifiers accept the RFC alphabet and reject coercion or out-of-range lengths", () => {
    for (const valid of ["A".repeat(43), "A".repeat(128), "a._~-".repeat(10)]) assert.equal(validMobileVerifier(valid), true);
    for (const invalid of [null, {}, 43, "A".repeat(42), "A".repeat(129), "A".repeat(43) + "\n", "a/".repeat(25)]) assert.equal(validMobileVerifier(invalid), false);
});
