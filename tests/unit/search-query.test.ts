import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildTsQuery, decodeSearchCursor, encodeSearchCursor, HEADLINE_START as S, HEADLINE_STOP as E, parseHeadline, parseSearchParams,
    parseSearchTypes, plainText, SEARCH_MAX_LIMIT, SEARCH_MAX_OFFSET, SEARCH_MAX_TERMS, SEARCH_TYPES, searchTerms, snippetParts,
} from "../../src/lib/search-query";

test("buildTsQuery: every word must match, the last one as a prefix", () => {
    assert.equal(buildTsQuery("invoice"), "invoice:*");
    assert.equal(buildTsQuery("Spring Menu land"), "spring & menu & land:*");
    assert.equal(buildTsQuery("  Café  Žltý  "), "café & žltý:*");
});

test("buildTsQuery: too short or nothing searchable is null", () => {
    for (const q of ["", " ", "a", "!", "&|!", "<->", "():*", "'\"", "--", "\u0000\u0002"]) assert.equal(buildTsQuery(q), null, JSON.stringify(q));
});

test("buildTsQuery: tsquery operators and SQL never survive", () => {
    const cases = ["zephyr' OR 1=1 --", "a & b | !c", "foo:* & !bar", "(x <-> y)", "'; DROP TABLE tasks; --", "x\\y", "%_", "a:B*", "\u0002x\u0003y"];
    for (const q of cases) {
        const ts = buildTsQuery(q);
        assert.ok(ts === null || /^[\p{L}\p{M}\p{N}]+(?: & [\p{L}\p{M}\p{N}]+)*:\*$/u.test(ts), `${q} -> ${ts}`);
    }
    assert.equal(buildTsQuery("'; DROP TABLE tasks; --"), "drop & table & tasks:*");
});

test("searchTerms: lower-cases, de-duplicates and caps the words", () => {
    assert.deepEqual(searchTerms("Foo foo FOO bar"), ["foo", "bar"]);
    assert.equal(searchTerms(Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ")).length, SEARCH_MAX_TERMS);
    assert.equal(searchTerms("x".repeat(300))[0].length, 64);
    // A decomposed accent stays with its letter.
    assert.deepEqual(searchTerms("café"), ["café"]);
});

test("parseSearchTypes / parseSearchParams: unknown values fall back safely", () => {
    assert.deepEqual(parseSearchTypes(null), [...SEARCH_TYPES]);
    assert.deepEqual(parseSearchTypes("task,MESSAGE, nope"), ["task", "message"]);
    assert.deepEqual(parseSearchTypes("nope"), [...SEARCH_TYPES]);
    const p = parseSearchParams(new URLSearchParams("q=hi&limit=999&type=agent&cursor=bad"));
    assert.deepEqual(p, { q: "hi", types: ["agent"], limit: SEARCH_MAX_LIMIT, offset: 0 });
    assert.equal(parseSearchParams(new URLSearchParams("limit=-3")).limit, 1);
    assert.equal(parseSearchParams(new URLSearchParams("limit=abc")).limit, 20);
});

test("search cursor: round-trips and clamps", () => {
    assert.equal(decodeSearchCursor(encodeSearchCursor(40)), 40);
    assert.equal(decodeSearchCursor(encodeSearchCursor(10_000)), SEARCH_MAX_OFFSET);
    assert.equal(decodeSearchCursor(encodeSearchCursor(-5)), 0);
    for (const bad of [null, "", "%%%", "x".repeat(100), Buffer.from('{"o":"1"}').toString("base64url"), Buffer.from("[]").toString("base64url")]) {
        assert.equal(decodeSearchCursor(bad), 0, String(bad));
    }
});

test("parseHeadline: markers become ranges over plain text", () => {
    const { snippet, highlights } = parseHeadline(`Send the ${S}invoice${E} to the ${S}café${E} owner`);
    assert.equal(snippet, "Send the invoice to the café owner");
    assert.deepEqual(highlights.map(([a, b]) => snippet.slice(a, b)), ["invoice", "café"]);
});

test("parseHeadline: HTML is stripped, never passed through", () => {
    const { snippet, highlights } = parseHeadline(`<b>bold</b> <script>alert(1)</script> ${S}zephyr${E} <img src=x onerror=alert(1)> <!-- c --> end`);
    assert.ok(!/[<>]/.test(snippet), snippet);
    assert.equal(snippet, "bold alert(1) zephyr end");
    assert.equal(snippet.slice(...highlights[0]), "zephyr");
    // A marker swallowed inside a tag leaves no dangling range.
    const swallowed = parseHeadline(`<a href="${S}x">link</a>${E} tail`);
    assert.equal(swallowed.snippet, "link tail");
    assert.deepEqual(swallowed.highlights, []);
    // A lone "<" in plain text is text, not a tag.
    assert.equal(parseHeadline("if a <b then 2 < 3").snippet, "if a <b then 2 < 3");
});

test("parseHeadline: unbalanced markers, control characters and length", () => {
    assert.deepEqual(parseHeadline(`${E}a ${S}open`), { snippet: "a open", highlights: [[2, 6]] });
    assert.equal(parseHeadline("a\u0000b\u0007c").snippet, "abc");
    assert.deepEqual(parseHeadline(null), { snippet: "", highlights: [] });
    const long = parseHeadline(`${S}${"y".repeat(500)}${E}`, 50);
    assert.equal(long.snippet.length, 51);
    assert.ok(long.snippet.endsWith("…"));
    assert.deepEqual(long.highlights, [[0, 50]]);
});

test("parseHeadline: markdown links read as their text, table rules disappear", () => {
    const { snippet, highlights } = parseHeadline(`See [Publish ${S}launch${E} post](emperor://task/abc-123) | Work | Owner | |---|---| | Copy |`);
    assert.equal(snippet, "See Publish launch post | Work | Owner | | Copy |");
    assert.equal(snippet.slice(...highlights[0]), "launch");
});

test("plainText: titles carry no markup and are capped", () => {
    assert.equal(plainText("<em>Hi</em>\n there"), "Hi there");
    assert.equal(plainText(`a${S}b${E}`), "ab");
    assert.equal(plainText("x".repeat(200), 10), `${"x".repeat(9)}…`);
});

test("snippetParts: splits into text nodes, ignoring bad ranges", () => {
    assert.deepEqual(snippetParts("one two three", [[4, 7]]), [
        { text: "one ", match: false }, { text: "two", match: true }, { text: " three", match: false },
    ]);
    assert.deepEqual(snippetParts("abc", [[1, 9], [0, 1]]), [{ text: "a", match: true }, { text: "bc", match: false }]);
});
