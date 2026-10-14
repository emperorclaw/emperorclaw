import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALWAYS_TRUNCATION_MARKER,
  buildAlwaysBlock,
  doctrineRank,
  orderKnowledgeNotesForIndex,
  renderKnowledgeIndex,
  scopeSpecificityRank,
  KNOWLEDGE_ALWAYS_MAX_CHARS,
  type KnowledgeIndexNote,
} from "../../src/lib/knowledge-index";

function note(overrides: Partial<KnowledgeIndexNote> & { id: string }): KnowledgeIndexNote {
  return {
    title: overrides.id,
    summary: "summary",
    scopeType: "company",
    scopeId: null,
    inject: "index",
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    configText: "",
    ...overrides,
  };
}

test("scope specificity ranks agent above project/customer above company", () => {
  assert.ok(scopeSpecificityRank("agent") < scopeSpecificityRank("project"));
  assert.equal(scopeSpecificityRank("project"), scopeSpecificityRank("customer"));
  assert.ok(scopeSpecificityRank("customer") < scopeSpecificityRank("company"));
});

test("index order is scope, then doctrine, then recency", () => {
  const ordered = orderKnowledgeNotesForIndex([
    note({ id: "company-old", updatedAt: new Date("2026-01-01") }),
    note({ id: "company-new", updatedAt: new Date("2026-06-01") }),
    note({ id: "company-doctrine", title: "Operating Doctrine", updatedAt: new Date("2025-01-01") }),
    note({ id: "project", scopeType: "project", scopeId: "p1" }),
    note({ id: "agent", scopeType: "agent", scopeId: "a1" }),
  ]);
  assert.deepEqual(ordered.map((entry) => entry.id), [
    "agent",
    "project",
    "company-doctrine",
    "company-new",
    "company-old",
  ]);
  assert.equal(doctrineRank(note({ id: "x", title: "Doctrine" })), 0);
});

test("index renders one line per note and caps lines and characters", () => {
  const notes = Array.from({ length: 40 }, (_, index) =>
    note({ id: `n${index}`, title: `Title ${index}`, summary: "one line" }),
  );
  const capped = renderKnowledgeIndex(notes, { maxLines: 5, maxChars: 10_000 });
  assert.equal(capped.lines.length, 5);
  assert.equal(capped.truncated, true);
  assert.match(capped.lines[0], /^Title 0 — one line — n0$/);

  const charCapped = renderKnowledgeIndex(notes, { maxLines: 40, maxChars: 60 });
  assert.ok(charCapped.text.length <= 60);
});

test("index never splits a line and reports non-truncation when everything fits", () => {
  const result = renderKnowledgeIndex([note({ id: "only" })], { maxLines: 25, maxChars: 2500 });
  assert.equal(result.truncated, false);
  assert.equal(result.ids.length, 1);
});

test("always block concatenates bodies under the budget", () => {
  const result = buildAlwaysBlock([
    note({ id: "a", configText: "first rule" }),
    note({ id: "b", configText: "second rule" }),
  ]);
  assert.equal(result.text, "first rule\n\nsecond rule");
  assert.equal(result.overBudget, false);
  assert.ok(result.usedChars <= KNOWLEDGE_ALWAYS_MAX_CHARS);
});

test("always block truncates the last note with a marker and flags over budget", () => {
  const long = "z".repeat(KNOWLEDGE_ALWAYS_MAX_CHARS + 500);
  const result = buildAlwaysBlock([
    note({ id: "short", configText: "keep me" }),
    note({ id: "long", configText: long }),
  ]);
  assert.ok(result.text.length <= KNOWLEDGE_ALWAYS_MAX_CHARS);
  assert.ok(result.text.includes(ALWAYS_TRUNCATION_MARKER));
  assert.equal(result.overBudget, true);
});
