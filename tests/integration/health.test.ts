import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable } from "./_helper";

const maybe = dbAvailable ? test : test.skip;

maybe("GET /api/health returns 200 and reports the database reachable", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.status, "ok");
    assert.equal(json.checks.database, "ok");
    assert.ok(json.version, "health should report the app version");
});

maybe("GET /api/health reports the build version (release tag) when APP_VERSION is set", async () => {
    const previous = process.env.APP_VERSION;
    process.env.APP_VERSION = "v0.31.1";
    try {
        const { GET } = await import("@/app/api/health/route");
        const res = await GET();
        const json = await res.json();
        // The contract the bridges poll must not change: status + checks.database.
        assert.equal(res.status, 200);
        assert.equal(json.status, "ok");
        assert.equal(json.checks.database, "ok");
        // The tag, with the `v` stripped: the value the release published.
        assert.equal(json.version, "0.31.1");
    } finally {
        if (previous === undefined) delete process.env.APP_VERSION;
        else process.env.APP_VERSION = previous;
    }
});
