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
