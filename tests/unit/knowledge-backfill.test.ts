import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWLEDGE_BACKFILL_CHUNK_SIZE,
  KNOWLEDGE_BACKFILL_MAX_ROWS,
  KNOWLEDGE_BACKFILL_STATEMENT_TIMEOUT,
  planKnowledgeSummaryUpdates,
} from "../../src/lib/knowledge-backfill";

test("the boot backfill is bounded and time-limited", () => {
  assert.equal(KNOWLEDGE_BACKFILL_MAX_ROWS, 2000);
  assert.equal(KNOWLEDGE_BACKFILL_CHUNK_SIZE, 200);
  assert.equal(KNOWLEDGE_BACKFILL_STATEMENT_TIMEOUT, "15s");
});

test("an empty body plans an empty-string summary that is never null", () => {
  const planned = planKnowledgeSummaryUpdates([
    { id: "a", configText: "" },
    { id: "b", configText: null },
    { id: "c", configText: "Refunds count against the client total." },
  ]);

  assert.deepEqual(planned, [
    { id: "a", summary: "" },
    { id: "b", summary: "" },
    { id: "c", summary: "Refunds count against the client total." },
  ]);
  // The empty string (not null) is what stops the row matching `summary IS NULL`
  // and being rescanned on every boot.
  assert.ok(planned.every((row) => row.summary !== null));
  assert.equal(planned[0].summary, "");
  assert.equal(planned[1].summary, "");
});

test("a non-empty body derives the same summary the read path would", async () => {
  const { deriveKnowledgeSummary } = await import("../../src/lib/knowledge-summary");
  const note = "---\nsummary: From frontmatter\n---\nbody must not be used";
  const [planned] = planKnowledgeSummaryUpdates([{ id: "x", configText: note }]);
  assert.equal(planned.summary, deriveKnowledgeSummary(note));
  assert.equal(planned.summary, "From frontmatter");
});
