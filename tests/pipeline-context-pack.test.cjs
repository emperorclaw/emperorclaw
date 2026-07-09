/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function assertContains(source, needle, message) {
  assert.ok(source.includes(needle), message || `Expected source to contain ${needle}`);
}

function assertFile(relativePath) {
  assert.ok(existsSync(resolve(root, relativePath)), `${relativePath} should exist`);
}

function hasExport(source, name) {
  const pattern = new RegExp(String.raw`export\s+(?:async\s+)?function\s+${name}\b`);
  return pattern.test(source);
}

test("Pipeline schema stores lightweight Company Brain context rules and run source snapshots", () => {
  const schema = read("src/db/schema.ts");
  [
    "contextQuery",
    "contextResourceIds",
    "contextTagFilters",
    "contextMaxChars",
    "context_source_ids",
    "context_snapshot",
  ].forEach((needle) => {
    assertContains(schema, needle, `pipeline schema should include ${needle}`);
  });
});

test("Pipeline helpers expose context pack parsing and run source snapshot helpers", () => {
  const source = read("src/lib/pipelines.ts");
  [
    "parsePipelineContextConfig",
    "buildPipelineContextParams",
    "extractRunContextSourceIds",
  ].forEach((name) => {
    assert.ok(hasExport(source, name), `pipelines.ts should export ${name}`);
  });
  assertContains(source, "contextResourceIds", "pipeline helper should preserve explicit resource context");
  assertContains(source, "contextTagFilters", "pipeline helper should preserve tag filters");
  assertContains(source, "contextMaxChars", "pipeline helper should enforce context budgets");
});

test("Pipeline MCP APIs accept context rules and run context source snapshots", () => {
  const registerRoute = read("src/app/api/mcp/pipelines/route.ts");
  ["contextQuery", "contextResourceIds", "contextTagFilters", "contextMaxChars", "parsePipelineContextConfig"].forEach((needle) => {
    assertContains(registerRoute, needle, `MCP pipeline registration should handle ${needle}`);
  });

  const runRoute = read("src/app/api/mcp/pipelines/[id]/runs/route.ts");
  ["contextSourceIds", "contextSnapshot", "extractRunContextSourceIds"].forEach((needle) => {
    assertContains(runRoute, needle, `MCP pipeline runs should persist ${needle}`);
  });
});

test("Pipelines UI and docs explain Context Pack without pretending Emperor executes pipelines", () => {
  const ui = read("src/app/(app)/pipelines/pipelines-client.tsx");
  ["Context Pack", "Sources used", "Evidence produced", "contextSourceIds", "contextSnapshot"].forEach((needle) => {
    assertContains(ui, needle, `Pipelines UI should show ${needle}`);
  });
  assert.equal(ui.includes("Chain of thought"), false, "Pipelines UI should not expose internal chain-of-thought language");

  const docs = read("src/content/docs/v1.1/pipelines.md");
  ["Context Pack", "GET /resources/context", "contextSourceIds", "Evidence produced"].forEach((needle) => {
    assertContains(docs, needle, `Pipelines docs should teach ${needle}`);
  });
  assertContains(docs, "Emperor never executes a pipeline", "docs must keep the agent-first execution boundary clear");

  assertFile("src/db/migrations/0021_pipeline_context_pack.sql");
});
