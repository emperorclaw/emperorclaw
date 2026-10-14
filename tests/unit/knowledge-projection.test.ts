import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWLEDGE_INDEX_COLUMNS } from "../../src/lib/resources";

test("the index projection never loads the note body or the secret", () => {
  const keys = Object.keys(KNOWLEDGE_INDEX_COLUMNS);
  assert.equal(keys.includes("configText"), false, "the index must not select configText");
  assert.equal(keys.includes("secretText"), false, "the index must not select secretText");

  for (const key of ["id", "name", "displayName", "summary", "scopeType", "scopeId", "inject", "updatedAt"]) {
    assert.ok(keys.includes(key), `projection should include ${key}`);
  }
});
