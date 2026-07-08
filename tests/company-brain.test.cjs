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

test("Company Brain schema exposes graph, tags, versions, and proposals", () => {
  const schema = read("src/db/schema.ts");
  ["resourceLinks", "resourceTags", "resourceVersions", "resourceProposals"].forEach((table) => {
    assertContains(schema, `export const ${table}`, `schema.ts should export ${table}`);
  });
  ["source_resource_id", "target_resource_id", "tag", "change_summary", "proposed_text"].forEach((column) => {
    assertContains(schema, column, `schema.ts should include ${column}`);
  });
});

test("Company Brain resource service exposes parsing, graph, proposal, and context helpers", () => {
  const source = read("src/lib/resources.ts");
  [
    "parseResourceMarkdownMetadata",
    "syncResourceBrainMetadata",
    "listResourceBacklinks",
    "listResourceGraph",
    "listResourceVersions",
    "createResourceProposal",
    "reviewResourceProposal",
    "resolveCompanyBrainContext",
  ].forEach((name) => {
    assert.ok(hasExport(source, name), `resources.ts should export ${name}`);
  });
});

test("Company Brain UI and MCP API routes exist", () => {
  [
    "src/app/api/resources/[id]/graph/route.ts",
    "src/app/api/resources/[id]/backlinks/route.ts",
    "src/app/api/resources/[id]/versions/route.ts",
    "src/app/api/resources/[id]/restore-version/route.ts",
    "src/app/api/resources/proposals/route.ts",
    "src/app/api/resources/proposals/[id]/route.ts",
    "src/app/api/mcp/resources/context/route.ts",
    "src/app/api/mcp/resources/proposals/route.ts",
  ].forEach(assertFile);
});

test("Company Brain operator UI includes brain feed, graph, backlinks, versions, and reduced motion", () => {
  const source = read("src/app/(app)/resources/resources-client.tsx");
  ["Company Brain", "Brain Feed", "Backlinks", "Versions", "Graph", "prefers-reduced-motion"].forEach((needle) => {
    assertContains(source, needle, `resources-client should include ${needle}`);
  });
});
