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
  assertContains(sidebar, 'name: "Dashboard"', "sidebar should include Dashboard");
  assertContains(sidebar, 'name: "Projects"', "sidebar should include Projects");
  assertContains(sidebar, 'name: "Approvals"', "sidebar should include Approvals");
  assertContains(sidebar, 'name: "Agents"', "sidebar should include Agents");
  assertContains(sidebar, 'name: "Files"', "sidebar should include Files");
  assertNotContains(sidebar, 'name: "Attention"', "sidebar should no longer route to the removed Attention/Incidents page");
  assertNotContains(sidebar, 'name: "Alerts"', "sidebar should no longer route to the removed Alerts/Incidents page");

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
  const globals = read("src/app/globals.css");
  const dashboard = read("src/app/(app)/page.tsx");
  const projects = read("src/app/(app)/projects/projects-client.tsx");
  const messages = read("src/app/(app)/messages/page.tsx");
  const messagingHub = read("src/components/messaging-hub.tsx");
  const teamChat = read("src/components/agent-team-chat.tsx");

  assertContains(dashboard, "emperor-panel", "dashboard should use shared Emperor panels");
  assertContains(projects, "emperor-panel", "projects should use shared Emperor panels");
  assertContains(messages, "emperor-panel", "messages should use shared Emperor panels");
  assertContains(projects, "Track work from to-do to done", "projects should use clear operator copy");
  assertContains(projects, "Advanced filters and project actions", "projects should hide secondary controls behind progressive disclosure");
  assertContains(messagingHub, "bg-zinc-950/70", "messages sidebar should match the OLED panel system");
  assertContains(globals, ".emperor-main .text-zinc-400", "app secondary text should be lifted on dark OLED surfaces");
  assertContains(globals, ".emperor-main .text-zinc-500", "app muted text contrast should be lifted on dark OLED surfaces");
  assertContains(globals, "font-weight: 550", "medium text should be heavier for readability on dark surfaces");
  assertContains(projects, "sm:text-3xl", "daily workspace headers should stay compact instead of using oversized hero titles");
  assertNotContains(projects, "sm:text-5xl", "projects should not look like a landing-page hero");

  [dashboard, projects, messages, messagingHub, teamChat].forEach((source) => {
    assertNotContains(source, "bg-zinc-900/50", "core workspaces should not use the older flat panel surface");
    assertNotContains(source, "text-indigo", "core workspaces should not drift back to the older indigo accent");
    assertNotContains(source, "bg-indigo", "core workspaces should not drift back to the older indigo accent");
    assertNotContains(source, "border-indigo", "core workspaces should not drift back to the older indigo accent");
  });
});

test("Directories scale with search-first navigation instead of card dumps", () => {
  const projects = read("src/app/(app)/projects/projects-client.tsx");
  const customers = read("src/app/(app)/customers/customers-client.tsx");
  const agents = read("src/app/(app)/agents/agents-client.tsx");
  const searchableSelect = read("src/components/ui/searchable-select.tsx");

  assertContains(searchableSelect, "SearchableSelect", "project filters should use a reusable searchable combobox");
  assertContains(searchableSelect, "pointerdown", "searchable combobox should close on outside click");
  assertContains(searchableSelect, "Escape", "searchable combobox should close on escape");
  assertNotContains(searchableSelect, "onBlur", "searchable combobox should not close when focus moves into its own search input");
  assertContains(projects, "SearchableSelect", "projects should use searchable customer/project/agent filters");
  assertContains(customers, "Search customers", "customers should have directory search");
  assertContains(customers, "Customer Directory", "customers should be framed as a scalable directory");
  assertContains(agents, "Search agents", "agents should have directory search");
  assertContains(agents, "Agent Directory", "agents should be framed as a scalable directory");
  assertNotContains(customers, "grid gap-6 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-6", "customers should not render a large card dump for every customer");
});


test("Operator polish pass keeps advanced pages consistent and removes dead-feeling interactions", () => {
  const resources = read("src/app/(app)/resources/resources-client.tsx");
  const approvals = read("src/app/(app)/approvals/approvals-client.tsx");
  const settings = read("src/app/(app)/settings/settings-client.tsx");
  const agents = read("src/app/(app)/agents/agents-client.tsx");
  const storage = read("src/app/(app)/artifacts/artifacts-manager.tsx");

  assertContains(resources, "Publish note", "draft KB notes should have an obvious publish action");
  assertContains(resources, "Move back to draft", "published KB notes should be reversible without hunting in metadata");
  assertContains(resources, "Shared is separate", "KB copy should clarify published versus agent injection");

  [approvals, settings, storage].forEach((source) => {
    assertContains(source, "max-w-[1800px]", "operator pages should use the standard wide workspace container");
  });

  assertContains(approvals, "Decision Queue", "approvals should be framed as a useful operator queue");
  assertNotContains(agents, "What belongs here", "agent cards should not repeat generic instructional copy");
  assertContains(agents, "Next actions for", "agent cards should expose useful per-agent actions");
  assertNotContains(storage, "window.confirm", "storage destructive actions should use app-native confirmation dialogs");
  assertContains(storage, "Delete folder?", "storage should confirm folder deletion in an app dialog");
  assertContains(storage, "Delete file?", "storage should confirm file deletion in an app dialog");
});
