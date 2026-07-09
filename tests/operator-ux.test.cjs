/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function assertContains(source, needle, message) {
  assert.ok(source.includes(needle), message || `Expected source to contain ${needle}`);
}

function assertNotContains(source, needle, message) {
  assert.equal(source.includes(needle), false, message || `Expected source not to contain ${needle}`);
}

test("Settings is runtime-neutral for operators and hides dangerous details behind Advanced", () => {
  const source = read("src/app/(app)/settings/settings-client.tsx");
  ["Workspace & Access", "Agent Connections", "Access Tokens", "Advanced", "Hermes agents", "OpenClaw agents"].forEach((needle) => {
    assertContains(source, needle, `settings should include ${needle}`);
  });
  assertNotContains(source, "authenticate your OpenClaw workforce", "settings should not frame the whole workspace as OpenClaw-only");
  assertNotContains(source, "OpenClaw Manager CLI", "token placeholder should be runtime-neutral");
  assertContains(source, "Show token scope internals", "dangerous token internals should be progressively disclosed");
  assertContains(source, "Agent access", "raw token scope should have a human label");
  assertContains(source, "Secret leasing", "privileged token scope should have a human label");
});

test("Operator navigation and docs expose the right pages without hiding key manuals", () => {
  const sidebar = read("src/components/app-sidebar.tsx");
  assertContains(sidebar, 'name: "Attention", href: "/incidents"', "sidebar should route Attention to the real incidents page");

  const attention = read("src/app/(app)/attention/page.tsx");
  assertContains(attention, 'redirect("/incidents")', "legacy attention route should redirect to incidents, not projects");

  const docs = read("src/components/docs-viewer.tsx");
  ["Operator Manual", "Runtime Setup", "company-brain", "resources-as-wiki-memory", "project-architecture", "pipelines"].forEach((needle) => {
    assertContains(docs, needle, `docs navigation should include ${needle}`);
  });
});

test("Customer and pipeline operator copy avoids runtime-specific or internal jargon", () => {
  const customers = read("src/app/(app)/customers/customers-client.tsx");
  assertNotContains(customers, "OpenClaw should", "customers should not imply only OpenClaw consumes customer context");
  assertContains(customers, "your agents should follow", "customers should use runtime-neutral agent wording");

  const pipelines = read("src/app/(app)/pipelines/pipelines-client.tsx");
  assertContains(pipelines, "documentation and grounding, not hidden reasoning", "pipelines should explain Context Pack in operator language");
  assertNotContains(pipelines, "via MCP", "pipelines UI copy should avoid MCP jargon for normal operators");
});
