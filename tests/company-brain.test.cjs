/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const { TextDecoder } = require("node:util");

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

test("Company Brain schema exposes graph, tags, versions, and legacy proposal storage", () => {
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
  assertContains(source, 'linkType: "inferred"', "resources.ts should infer links when KB docs mention existing note titles");
  assertContains(source, "mentionsResourceTitle", "resources.ts should include title mention detection for agent-created docs");
  assertContains(source, "frontmatter", "resources.ts should parse Obsidian-style frontmatter metadata");
  assertContains(source, "inlineTags", "resources.ts should support frontmatter tags for agent-created notes");
  assertContains(source, "sources: resources", "context resolver should return sources for bridge/source citation compatibility");
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

test("Knowledge & Rules UI keeps Company Brain advanced concepts operator-friendly", () => {
  const source = read("src/app/(app)/resources/resources-client.tsx");
  ["Knowledge & Rules", "Vault explorer", "Reading", "Source", "Properties", "Local graph", "Linked mentions", "customerNames", "projectNames", "agentNames", "Publication status", "Needs review", "Published", "setNoteStatus", "Inject into matching agents", "shared means context injection", "drafts", "status: draft", "Delete note", "createLinkedResource", "selectAdjacentResource", "UnresolvedGraphNode", "Graph connections", "overflow-y-auto"].forEach((needle) => {
    assertContains(source, needle, `resources-client should include ${needle}`);
  });
  ["Brain Feed", "Backlinks", "Company Brain</h1>", "Suggest an update", "Add to Review Queue", "Review Queue", "Agent suggestions", "Advanced relationships", "prefers-reduced-motion", "Vault settings", "More actions"].forEach((needle) => {
    assert.equal(source.includes(needle), false, `resources-client should not expose ${needle} as primary UI`);
  });
});


test("Hermes bridge and docs use Company Brain context resolver", () => {
  const bridge = read("integrations/hermes/emperor-claw/bridge/emperor_hermes_bridge.py");
  assertContains(bridge, "format_company_brain_context", "Hermes bridge should use the Company Brain context formatter");
  assertContains(bridge, "GET", "Hermes bridge should call Emperor APIs for context");
  assertContains(bridge, "/resources/context", "Hermes bridge should resolve context through the centralized endpoint");
  assertContains(bridge, "status: active", "Hermes bridge should guide agents to published notes by default");
  assertContains(bridge, "status: draft only", "Hermes bridge should reserve draft for uncertain notes");
  assert.equal(bridge.includes("POST /resources/proposals"), false, "Hermes bridge should not teach proposal queues as the normal path");

  const docs = read("src/content/docs/v1.1/company-brain.md");
  ["shared knowledge vault", "status: active", "status: draft only", "There is no separate review queue", "Agent note contract", "Obsidian-inspired conventions", "GET /api/mcp/resources/context", "POST /api/mcp/resources"].forEach((needle) => {
    assertContains(docs, needle, `Company Brain docs should include ${needle}`);
  });
  ["Agent suggestions", "proposal-first"].forEach((needle) => {
    assert.equal(docs.includes(needle), false, `Company Brain docs should not teach ${needle}`);
  });

  const hermesSkill = read("integrations/hermes/emperor-claw/skills/emperor-claw/SKILL.md");
  ["Company Brain Note Protocol", "frontmatter", "[[wikilinks]]", "status: active", "status: draft only", "POST /resources"].forEach((needle) => {
    assertContains(hermesSkill, needle, `Hermes skill should teach agents ${needle}`);
  });
  assert.equal(hermesSkill.includes("POST /resources/proposals"), false, "Hermes skill should not teach proposal queues as normal workflow");
});


test("Company Brain UI source is valid UTF-8", () => {
  const bytes = require("node:fs").readFileSync(resolve(root, "src/app/(app)/resources/resources-client.tsx"));
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assert.equal(/[\u0080-\u009f\ufffd]/u.test(source), false, "source should not contain replacement or C1 control characters");
});
