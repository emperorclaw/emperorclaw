import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { appVersion, normalizeVersion } from "../../src/lib/app-version";

const pkgVersion: string = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")).version;

function withAppVersion<T>(value: string | undefined, fn: () => T): T {
    const previous = process.env.APP_VERSION;
    if (value === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = value;
    try {
        return fn();
    } finally {
        if (previous === undefined) delete process.env.APP_VERSION;
        else process.env.APP_VERSION = previous;
    }
}

test("the release tag wins over package.json and is reported without the v", () => {
    // v0.31.1 shipped while package.json still said 0.31.0; the tag is truth.
    assert.equal(withAppVersion("v0.31.1", appVersion), "0.31.1");
});

test("an unprefixed build version is passed through", () => {
    assert.equal(withAppVersion("0.31.1", appVersion), "0.31.1");
});

test("surrounding whitespace from the build environment is trimmed", () => {
    assert.equal(withAppVersion("  v1.2.3\n", appVersion), "1.2.3");
});

test("without APP_VERSION the package.json version is the fallback", () => {
    assert.equal(withAppVersion(undefined, appVersion), pkgVersion);
    assert.equal(withAppVersion("", appVersion), pkgVersion);
    assert.equal(withAppVersion("   ", appVersion), pkgVersion);
});

test("normalizeVersion only strips a leading v before a digit", () => {
    assert.equal(normalizeVersion("v1.2.3"), "1.2.3");
    assert.equal(normalizeVersion("V2.0.0"), "2.0.0");
    assert.equal(normalizeVersion("v1.2.3-rc.1"), "1.2.3-rc.1");
    assert.equal(normalizeVersion("1.2.3"), "1.2.3");
    // Not a version: leave it alone instead of mangling a branch name.
    assert.equal(normalizeVersion("version-2"), "version-2");
});
