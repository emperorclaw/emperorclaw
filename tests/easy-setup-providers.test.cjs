/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

const FREE_OPENROUTER_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

test("Easy Setup offers only OpenRouter and DeepSeek for local hiring", () => {
  const source = read("src/app/(app)/agents/easy-setup-dialog.tsx");
  ["openrouter", "deepseek"].forEach((id) => {
    assert.ok(source.includes(`id: "${id}"`), `Easy Setup should offer ${id}`);
  });
  ["openai", "anthropic", "google", "grok"].forEach((id) => {
    assert.ok(!source.includes(`id: "${id}"`), `Easy Setup should no longer offer ${id}`);
  });
});

test("Easy Setup defaults OpenRouter to the free Nemotron model", () => {
  const source = read("src/app/(app)/agents/easy-setup-dialog.tsx");
  assert.ok(source.includes(FREE_OPENROUTER_MODEL), "OpenRouter should default to the free model");
});

test("Hermes runtime defaults OpenRouter to the same free model", () => {
  const entrypoint = read("integrations/hermes/entrypoint.sh");
  assert.ok(entrypoint.includes(FREE_OPENROUTER_MODEL), "entrypoint.sh should default OpenRouter to the free model");
});

test("Free OpenRouter model is seeded at zero cost", () => {
  const migrationPath = "src/db/migrations/0044_free-openrouter-model.sql";
  assert.ok(existsSync(resolve(root, migrationPath)), "a migration should seed the free model pricing");
  const sql = read(migrationPath);
  assert.ok(sql.includes(FREE_OPENROUTER_MODEL), "migration should insert the free model");
  assert.ok(sql.includes("0, 0"), "free model pricing should be zero");
  const journal = read("src/db/migrations/meta/_journal.json");
  assert.ok(journal.includes("0044_free-openrouter-model"), "migration journal should list the new migration");
});
