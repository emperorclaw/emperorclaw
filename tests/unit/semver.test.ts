import test from "node:test";
import assert from "node:assert/strict";
import { isVersionNewer } from "../../src/lib/semver";

test("isVersionNewer: basic ordering", () => {
    assert.equal(isVersionNewer("1.2.0", "1.1.0"), true);
    assert.equal(isVersionNewer("1.1.0", "1.2.0"), false);
    assert.equal(isVersionNewer("1.1.0", "1.1.0"), false);
    assert.equal(isVersionNewer("2.0.0", "1.9.9"), true);
});

test("isVersionNewer: patch and differing segment counts", () => {
    assert.equal(isVersionNewer("1.1.1", "1.1.0"), true);
    assert.equal(isVersionNewer("1.1", "1.1.0"), false);   // 1.1 == 1.1.0
    assert.equal(isVersionNewer("1.1.1", "1.1"), true);    // 1.1.1 > 1.1.0
});

test("isVersionNewer: non-numeric / pre-release parts count as 0", () => {
    assert.equal(isVersionNewer("1.2.0-beta", "1.2.0"), false); // 1.2.0 == 1.2.0
    assert.equal(isVersionNewer("1.3.0-beta", "1.2.0"), true);
    assert.equal(isVersionNewer("garbage", "1.0.0"), false);
});
