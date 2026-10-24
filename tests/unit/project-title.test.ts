import { test } from "node:test";
import assert from "node:assert/strict";
import { clipAtWord, normalizeProjectInput, PROJECT_NAME_MAX, projectTitle, splitProjectTitle } from "../../src/lib/project-title";

test("a short name is kept as-is, even with a separator", () => {
    assert.deepEqual(splitProjectTitle("Acme: Q3 launch"), { name: "Acme: Q3 launch", description: null, clipped: false });
    assert.deepEqual(splitProjectTitle("  Harbor   Dental website relaunch "), { name: "Harbor Dental website relaunch", description: null, clipped: false });
});

test("an em dash splits a production-style overlong name into name and description", () => {
    const out = splitProjectTitle("Slovak e-shop + XML feed discovery — build shared, continuously-updated dataset of Slovak merchants and their public product feeds (Heureka-compatible focus)");
    assert.equal(out.name, "Slovak e-shop + XML feed discovery");
    assert.equal(out.description, "Build shared, continuously-updated dataset of Slovak merchants and their public product feeds (Heureka-compatible focus)");
    assert.equal(out.clipped, false);
});

test("the earliest separator wins and hyphenated words are not split", () => {
    const out = splitProjectTitle("Malecu AI Automation Report Outbound Campaign — Launch readiness, lead sourcing, cold email campaigns, and booked meetings for SK/CZ SMBs");
    assert.equal(out.name, "Malecu AI Automation Report Outbound Campaign");
    assert.match(out.description ?? "", /^Launch readiness/);
    const colon = splitProjectTitle("Ridgeline SEO: grow organic traffic for the outdoor gear catalogue - phase two with link building");
    assert.equal(colon.name, "Ridgeline SEO");
    assert.match(colon.description ?? "", /^Grow organic traffic/);
});

test("spaced hyphen and en dash also split", () => {
    assert.equal(splitProjectTitle("Spring campaign - posts, newsletter, in-store posters and the paid social test for April").name, "Spring campaign");
    assert.equal(splitProjectTitle("Spring campaign – posts, newsletter, in-store posters and the paid social test for April").name, "Spring campaign");
});

test("no separator: the name is clipped at a word boundary and the description keeps the full text", () => {
    const raw = "Build a continuously updated dataset of every Slovak merchant and the public product feeds they publish for comparison sites";
    const out = splitProjectTitle(raw);
    assert.ok(out.name.length <= PROJECT_NAME_MAX);
    assert.ok(raw.startsWith(out.name));
    assert.ok(!out.name.endsWith(" "));
    assert.equal(out.description, raw);
    assert.equal(out.clipped, true);
});

test("a head that is itself too long is clipped and keeps the original in the description", () => {
    const raw = "An extremely long project head that goes on and on past the sixty character limit — tail";
    const out = splitProjectTitle(raw);
    assert.ok(out.name.length <= PROJECT_NAME_MAX);
    assert.equal(out.description, raw);
    assert.equal(out.clipped, true);
});

test("clipAtWord cuts one giant token hard instead of returning nothing", () => {
    const token = "x".repeat(120);
    assert.equal(clipAtWord(token, 60).length, 60);
    assert.equal(clipAtWord("alpha beta, gamma", 12), "alpha beta");
});

test("empty and non-string input is safe", () => {
    assert.deepEqual(splitProjectTitle(""), { name: "", description: null, clipped: false });
    assert.deepEqual(splitProjectTitle(undefined), { name: "", description: null, clipped: false });
    assert.deepEqual(projectTitle(null), { name: "", description: null, clipped: false });
});

test("projectTitle prefers a real description column and keeps text carved off the name", () => {
    assert.deepEqual(projectTitle({ goal: "Harbor Dental relaunch", description: "Booking-first site" }), { name: "Harbor Dental relaunch", description: "Booking-first site", clipped: false });
    const merged = projectTitle({ goal: "Outbound campaign — launch readiness, lead sourcing and booked meetings for SK/CZ SMBs", description: "Owner: Jana" });
    assert.equal(merged.name, "Outbound campaign");
    assert.equal(merged.description, "Launch readiness, lead sourcing and booked meetings for SK/CZ SMBs\n\nOwner: Jana");
});

test("normalizeProjectInput passes short names, splits long ones, or rejects them on request", () => {
    assert.deepEqual(normalizeProjectInput({ name: "Spring campaign", description: " Bakery promo " }), { ok: true, name: "Spring campaign", description: "Bakery promo", autoSplit: false });
    const split = normalizeProjectInput({ name: "Slovak e-shop + XML feed discovery — build a shared dataset of merchants and their public feeds", description: "Heureka first" });
    assert.equal(split.ok, true);
    if (split.ok) {
        assert.equal(split.name, "Slovak e-shop + XML feed discovery");
        assert.equal(split.description, "Build a shared dataset of merchants and their public feeds\n\nHeureka first");
        assert.equal(split.autoSplit, true);
    }
    const rejected = normalizeProjectInput({ name: "x ".repeat(50) }, { mode: "reject" });
    assert.equal(rejected.ok, false);
    assert.deepEqual(normalizeProjectInput({ name: "   " }), { ok: false, error: "Project name is required." });
});
