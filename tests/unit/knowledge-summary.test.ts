import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampKnowledgeSummary,
  deriveKnowledgeSummary,
  injectModeFromIsShared,
  isSharedFromInjectMode,
  normalizeKnowledgeInjectMode,
  DERIVED_SUMMARY_MAX_CHARS,
  KNOWLEDGE_SUMMARY_MAX_CHARS,
} from "../../src/lib/knowledge-summary";

test("frontmatter summary wins over the body", () => {
  const note = `---\nsummary: Refunds count against the client total.\n---\n\n# Ignored heading\n\nThis body sentence must not be used.`;
  assert.equal(deriveKnowledgeSummary(note), "Refunds count against the client total.");
});

test("frontmatter summary supports a block scalar and quoted values", () => {
  assert.equal(deriveKnowledgeSummary(`---\nsummary: "Quoted line."\n---\nbody`), "Quoted line.");
  assert.equal(deriveKnowledgeSummary(`---\nsummary:\n  folded first line\n  second line\n---\nbody`), "folded first line second line");
});

test("no frontmatter summary falls back to the first body sentence with markdown stripped", () => {
  const note = `# Heading\n\n**Bold** intro with a [link](https://x) and \`code\`. Second sentence here.`;
  assert.equal(deriveKnowledgeSummary(note), "Bold intro with a link and code.");
});

test("a long body is truncated to the derived ceiling with an ellipsis", () => {
  const body = "x".repeat(400);
  const summary = deriveKnowledgeSummary(body);
  assert.ok(summary.length <= DERIVED_SUMMARY_MAX_CHARS);
  assert.ok(summary.endsWith("\u2026"));
});

test("an empty body derives an empty summary", () => {
  assert.equal(deriveKnowledgeSummary(""), "");
  assert.equal(deriveKnowledgeSummary("---\nstatus: active\n---\n"), "");
});

test("clamp bounds a stored summary at 200 chars", () => {
  const clamped = clampKnowledgeSummary("y".repeat(500));
  assert.equal(clamped.length, KNOWLEDGE_SUMMARY_MAX_CHARS);
  assert.equal(clampKnowledgeSummary("  spaced  "), "spaced");
});

test("isShared maps to inject and back", () => {
  assert.equal(injectModeFromIsShared(true), "index");
  assert.equal(injectModeFromIsShared(false), "on_request");
  assert.equal(isSharedFromInjectMode("always"), true);
  assert.equal(isSharedFromInjectMode("index"), true);
  assert.equal(isSharedFromInjectMode("on_request"), false);
});

test("unknown inject inputs fall back to index", () => {
  assert.equal(normalizeKnowledgeInjectMode(" ALWAYS "), "always");
  assert.equal(normalizeKnowledgeInjectMode("nonsense"), "index");
  assert.equal(normalizeKnowledgeInjectMode(null), "index");
});
