import { test } from "node:test";
import assert from "node:assert/strict";
import { clipForRedaction, REDACT_INPUT_MAX, redactSensitive } from "../../src/lib/redact-sensitive";
import { redactAuditPayload } from "../../src/lib/audit-format";
import { classifyFailure, shortFailureText } from "../../src/lib/failure-cause";
import { cleanSnippet } from "../../src/lib/live-feed-v2";
import { truncateRunError } from "../../src/lib/run-ledger";

const SIZE = 300_000;
const BUDGET_MS = 50;

/** Inputs that made the old patterns scan-and-fail at every position (quadratic). */
const ADVERSARIAL: Record<string, string> = {
    "no @ after a long local part": "a".repeat(SIZE),
    "long dot run": ".".repeat(SIZE),
    "dotted words, no @": "a.".repeat(SIZE / 2),
    "@ then a dotted domain": `x@${"a.".repeat(SIZE / 2)}`,
    "@ then one huge label": `x@${"a".repeat(SIZE)}`,
    "base64-ish with + and /": "Ab1+Cd2/".repeat(SIZE / 8),
    "url-safe opaque run": "Ab1_Cd2-".repeat(SIZE / 8),
    "hex run": "0123456789abcdef".repeat(SIZE / 16),
    "JWT starts with no dot": "eyJ-".repeat(SIZE / 4),
    "PEM header that never closes": `-----BEGIN ${"A".repeat(SIZE)}`,
    "keyword then whitespace": `password${" ".repeat(SIZE)}`,
    "keyword soup": "key token secret ".repeat(SIZE / 17),
    "authorization with spaces": `authorization${" ".repeat(SIZE)}x`,
};

function elapsedMs(fn: () => unknown): number {
    const start = performance.now();
    fn();
    return performance.now() - start;
}

test("redactSensitive: 300k-char adversarial inputs finish fast", () => {
    redactSensitive("warm up the regexes a@b.co sk-abcdef123");
    for (const [name, input] of Object.entries(ADVERSARIAL)) {
        const ms = elapsedMs(() => redactSensitive(input));
        assert.ok(ms < BUDGET_MS, `${name}: ${ms.toFixed(1)} ms`);
    }
});

test("every redacting caller clips before redacting", () => {
    for (const [name, input] of Object.entries(ADVERSARIAL)) {
        const ms = elapsedMs(() => {
            redactAuditPayload("customer", { after: { name: input } });
            shortFailureText(input);
            cleanSnippet(input, 120);
            cleanSnippet(input, Number.MAX_SAFE_INTEGER);
            truncateRunError(input);
        });
        assert.ok(ms < BUDGET_MS * 5, `${name}: ${ms.toFixed(1)} ms`);
    }
});

test("classifyFailure: repeated phrases stay linear", () => {
    const text = "permission denied ".repeat(SIZE / 18);
    const ms = elapsedMs(() => classifyFailure({ texts: [text] }));
    assert.ok(ms < BUDGET_MS, `${ms.toFixed(1)} ms`);
});

test("redactSensitive: the bounded patterns still redact real values", () => {
    assert.equal(redactSensitive("mail ana.lopez+ops@mail.example.co.uk now"), "mail [email] now");
    assert.equal(redactSensitive("auth Bearer abcdefgh12345678"), "auth Bearer [secret]");
    assert.equal(redactSensitive("Authorization: Token abc123"), "Authorization: [secret]");
    assert.equal(redactSensitive("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc done"), "jwt [secret] done");
    assert.equal(redactSensitive("-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY----- after"), "[secret] after");
});

test("clipForRedaction: caps the input and drops a cut trailing token", () => {
    assert.equal(clipForRedaction("short text", 100), "short text");
    assert.equal(clipForRedaction("keep this sk-abcdef1234567890", 18), "keep this");
    assert.equal(clipForRedaction("x".repeat(50), 10), "x".repeat(10), "one unbroken token is cut, not dropped");
    assert.equal(clipForRedaction("a ".repeat(REDACT_INPUT_MAX), Number.MAX_SAFE_INTEGER).length <= REDACT_INPUT_MAX, true);
});

test("redactSensitive: a key straddling the input cap never leaks a fragment", () => {
    const prefix = "word ".repeat(Math.floor((REDACT_INPUT_MAX - 10) / 5));
    const out = redactSensitive(`${prefix}sk-${"A1b2".repeat(50)} tail`);
    assert.ok(!out.includes("sk-"), "the half key is dropped");
    assert.ok(!/A1b2/.test(out));
    assert.ok(out.length <= REDACT_INPUT_MAX);
});
