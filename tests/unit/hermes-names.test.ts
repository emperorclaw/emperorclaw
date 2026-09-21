import { test } from "node:test";
import assert from "node:assert/strict";
import { hermesSafeName, hermesContainerName, hermesVolumeName } from "../../src/lib/hermes-names";

test("hermesSafeName lowercases and replaces unsafe characters", () => {
    assert.equal(hermesSafeName("SEO Agent"), "seo-agent");
    assert.equal(hermesSafeName("Sales/Support"), "sales-support");
    assert.equal(hermesSafeName("MiXeD.name"), "mixed-name");
});

test("hermes container and volume names share the agent id prefix", () => {
    const id = "12345678-90ab-cdef-1234-567890abcdef";
    assert.equal(hermesContainerName("seo-agent", id), "emperor-hermes-seo-agent-12345678");
    assert.equal(hermesVolumeName("seo-agent", id), "emperor-hermes-seo-agent-12345678-home");
});
