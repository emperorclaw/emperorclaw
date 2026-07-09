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

test("Storage keeps operator workflow folder-first and hides technical metadata", () => {
  const storage = read("src/app/(app)/artifacts/artifacts-manager.tsx");
  assertContains(storage, "Folder-first files, deliverables, proofs", "storage should explain the operator workflow first");
  assertContains(storage, "without knowing the backing storage provider", "storage should keep providers abstracted from agents/operators");
  assertContains(storage, "Advanced filters", "task/type filters should be behind progressive disclosure");
  assertContains(storage, "Advanced folder metadata", "folder metadata JSON should be behind progressive disclosure");
  assertNotContains(storage, "All kinds", "normal storage filters should not expose implementation-ish kind language");

  const directChat = read("src/components/agent-direct-chat.tsx");
  assertNotContains(directChat, "OpenClaw should answer", "direct chat empty state should be runtime-neutral");
  assertContains(directChat, "connected agent should answer", "direct chat should refer to the connected agent generically");
});

test("Core workspaces use the standardized Emperor visual system", () => {
  const dashboard = read("src/app/(app)/page.tsx");
  const projects = read("src/app/(app)/projects/projects-client.tsx");
  const messages = read("src/app/(app)/messages/page.tsx");
  const messagingHub = read("src/components/messaging-hub.tsx");
  const teamChat = read("src/components/agent-team-chat.tsx");

  assertContains(dashboard, "emperor-panel", "dashboard should use shared Emperor panels");
  assertContains(projects, "emperor-panel", "projects should use shared Emperor panels");
  assertContains(messages, "emperor-panel", "messages should use shared Emperor panels");
  assertContains(projects, "Recurring definitions stay separated", "projects should use clear operator copy");
  assertContains(messagingHub, "bg-zinc-950/70", "messages sidebar should match the OLED panel system");

  [dashboard, projects, messages, messagingHub, teamChat].forEach((source) => {
    assertNotContains(source, "bg-zinc-900/50", "core workspaces should not use the older flat panel surface");
    assertNotContains(source, "text-indigo", "core workspaces should not drift back to the older indigo accent");
    assertNotContains(source, "bg-indigo", "core workspaces should not drift back to the older indigo accent");
    assertNotContains(source, "border-indigo", "core workspaces should not drift back to the older indigo accent");
  });
});
