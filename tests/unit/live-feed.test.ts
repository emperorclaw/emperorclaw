import { test } from "node:test";
import assert from "node:assert/strict";
import {
    agentHue,
    clampMessageCount,
    deriveLiveState,
    etagMatches,
    liveFeedEtag,
    shortName,
    toPlainText,
    truncateText,
    type LiveFeed,
} from "../../src/lib/live-feed";
import { hasRequiredCompanyTokenScope, isCompanyTokenScope, isIsolatedCompanyTokenScope, normalizeCompanyTokenScope } from "../../src/lib/mcp";

test("short name is the first word, at most 10 characters", () => {
    assert.equal(shortName("Ada Researcher"), "Ada");
    assert.equal(shortName("  Bartholomew-the-Great  Builder"), "Bartholomew-the-Great".slice(0, 10));
    assert.equal(shortName("Zoë"), "Zoë");
    assert.equal(shortName(""), "Agent");
    assert.equal(shortName(null, "Someone"), "Someone");
});

test("hue is stable per id and within 0-359", () => {
    const id = "6f1c2a3e-1111-4222-8333-944455556666";
    assert.equal(agentHue(id), agentHue(id));
    for (const sample of [id, "a", "", "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
        const hue = agentHue(sample);
        assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `${sample} -> ${hue}`);
    }
    assert.notEqual(agentHue("agent-one"), agentHue("agent-two"));
});

test("markdown and rich blocks become one line of plain text", () => {
    assert.equal(toPlainText("**Done** with the _Q3_ report — see [the task](emperor://task/123)."), "Done with the Q3 report — see the task.");
    assert.equal(toPlainText("# Heading\n\n- one\n- two\n\n> quoted `code`"), "Heading one two quoted code");
    assert.equal(toPlainText("Revenue:\n```chart\n{\"type\":\"bar\"}\n```\nUp 12%"), "Revenue: [chart] Up 12%");
    assert.equal(toPlainText("Pick one\n```choices\n{\"options\":[\"A\"]}\n```"), "Pick one [choices]");
    assert.equal(toPlainText("```ts\nconst x = 1;\n```"), "[code]");
    assert.equal(toPlainText("| a | b |\n|---|---|\n| 1 | 2 |"), "a b 1 2");
    assert.equal(toPlainText("keep snake_case_names and 2*3*4"), "keep snake_case_names and 2*3*4");
    assert.equal(toPlainText("<b>hi</b>&nbsp;there ![logo](x.png)"), "hi there logo");
    assert.equal(toPlainText("   \n\n  "), "");
    const long = toPlainText("word ".repeat(60));
    assert.ok(long.length <= 100 && long.endsWith("..."), long);
});

test("truncation never splits an emoji", () => {
    assert.equal(truncateText("short", 10), "short");
    const cut = truncateText("😀".repeat(20), 10);
    assert.equal(Array.from(cut).length, 10);
    assert.ok(!cut.includes("�"));
});

test("state: typing beats offline beats working beats idle", () => {
    assert.equal(deriveLiveState({ typing: true, online: false, hasTaskInProgress: false }), "typing");
    assert.equal(deriveLiveState({ typing: false, online: false, hasTaskInProgress: true }), "offline");
    assert.equal(deriveLiveState({ typing: false, online: true, hasTaskInProgress: true }), "working");
    assert.equal(deriveLiveState({ typing: false, online: true, hasTaskInProgress: false }), "idle");
});

test("?messages= is clamped to 0..20 with a default of 8", () => {
    assert.equal(clampMessageCount(null), 8);
    assert.equal(clampMessageCount(""), 8);
    assert.equal(clampMessageCount("abc"), 8);
    assert.equal(clampMessageCount("-5"), 0);
    assert.equal(clampMessageCount("0"), 0);
    assert.equal(clampMessageCount("12"), 12);
    assert.equal(clampMessageCount("500"), 20);
});

test("the ETag ignores the clocks but not the content", () => {
    const feed: LiveFeed = {
        v: 1,
        ts: "2026-10-05T12:00:00.000Z",
        company: { name: "Acme" },
        summary: { agents: 1, healthy: 1, attention: 0, down: 0, idle: 0, working: 1, pendingApprovals: 0, tasksInProgress: 1, tasksOverdue: 0 },
        agents: [{ id: "a", name: "Ada", short: "Ada", hue: 1, health: "healthy", state: "working", activity: null, task: null, lastSeenSec: 3, unanswered: 0 }],
        messages: [{ id: "m", from: "Ada", agentId: "a", text: "hi", ageSec: 4 }],
    };
    const later = { ...feed, ts: "2026-10-05T12:00:09.000Z", agents: [{ ...feed.agents[0], lastSeenSec: 12 }], messages: [{ ...feed.messages[0], ageSec: 13 }] };
    assert.equal(liveFeedEtag(feed), liveFeedEtag(later));
    const changed = { ...feed, agents: [{ ...feed.agents[0], state: "typing" as const, activity: "Reading" }] };
    assert.notEqual(liveFeedEtag(feed), liveFeedEtag(changed));

    const etag = liveFeedEtag(feed);
    assert.ok(etagMatches(etag, etag));
    assert.ok(etagMatches(`W/${etag}`, etag));
    assert.ok(etagMatches(`"other", ${etag}`, etag));
    assert.ok(etagMatches("*", etag));
    assert.ok(!etagMatches(null, etag));
    assert.ok(!etagMatches('"other"', etag));
});

test("read_only is a real, isolated scope that satisfies nothing else", () => {
    assert.ok(isCompanyTokenScope("read_only"));
    assert.equal(normalizeCompanyTokenScope("read_only"), "read_only");
    assert.equal(normalizeCompanyTokenScope("bogus"), "mcp_full");
    assert.ok(isIsolatedCompanyTokenScope("read_only"));
    assert.ok(isIsolatedCompanyTokenScope("requests"));
    assert.ok(!isIsolatedCompanyTokenScope("mcp_full"));
    for (const required of ["mcp_full", "mcp_danger", "requests"] as const) {
        assert.equal(hasRequiredCompanyTokenScope("read_only", required), false, `read_only !>= ${required}`);
    }
    for (const required of ["mcp_full", "mcp_danger", "read_only"] as const) {
        assert.equal(hasRequiredCompanyTokenScope("requests", required), false, `requests !>= ${required}`);
    }
    assert.equal(hasRequiredCompanyTokenScope("mcp_danger", "read_only"), false);
    assert.equal(hasRequiredCompanyTokenScope("mcp_danger", "mcp_full"), true);
    assert.equal(hasRequiredCompanyTokenScope("mcp_full", "mcp_danger"), false);
});
