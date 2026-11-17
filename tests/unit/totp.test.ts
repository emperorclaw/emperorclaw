import { test } from "node:test";
import assert from "node:assert/strict";
import { generateTotpSecret, totpAt, matchingTotpStep, generateRecoveryCodes, recoveryHash } from "../../src/lib/totp";

// RFC 6238 Appendix B SHA-1 vectors (base32 of ASCII 12345678901234567890).
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
test("RFC 6238 SHA-1 vectors including timestamps beyond 2038", () => {
    for (const [seconds, expected] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]] as const) {
        assert.equal(totpAt(secret, Math.floor(seconds / 30), 8), expected);
    }
});
test("accept only fresh six-digit codes within one step", () => {
    const now = 1234567890000;
    const step = Math.floor(now / 30000);
    for (const offset of [-1, 0, 1]) assert.equal(matchingTotpStep(secret, totpAt(secret, step + offset), -1, now), step + offset);
    assert.equal(matchingTotpStep(secret, totpAt(secret, step), step, now), null);
    assert.equal(matchingTotpStep(secret, totpAt(secret, step - 2), -1, now), null);
    for (const invalid of ["", "00000", "0000000", "12345x"]) assert.equal(matchingTotpStep(secret, invalid, -1, now), null);
});
test("unique random secrets and normalized recovery codes", () => {
    const secrets = Array.from({ length: 100 }, generateTotpSecret);
    assert.equal(new Set(secrets).size, 100);
    for (const value of secrets) assert.match(value, /^[A-Z2-7]{32}$/);
    const codes = generateRecoveryCodes();
    assert.equal(new Set(codes).size, 10);
    for (const code of codes) {
        assert.match(code, /^[a-f0-9]{5}(-[a-f0-9]{5}){3}$/);
        assert.equal(recoveryHash(code), recoveryHash(code.toUpperCase().replace(/-/g, "")));
    }
});
