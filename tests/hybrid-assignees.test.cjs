const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("hybrid assignment migration is additive and registered", () => {
  const migrationPath = "src/db/migrations/0034_hybrid-task-assignees.sql";
  assert.equal(existsSync(resolve(root, migrationPath)), true);
  const migration = read(migrationPath);
  const journal = read("src/db/migrations/meta/_journal.json");

  assert.match(migration, /ADD COLUMN "assigned_member_id" uuid/);
  assert.match(migration, /ON DELETE set null/);
  assert.match(migration, /tasks_single_assignee/);
  assert.equal(migration.includes("DROP COLUMN"), false);
  assert.equal(migration.includes("UPDATE \"tasks\""), false);
  assert.match(journal, /0034_hybrid-task-assignees/);
});

test("task schema keeps legacy agent assignment and adds one human assignment", () => {
  const schema = read("src/db/schema.ts");
  assert.match(schema, /assignedAgentId: uuid\("assigned_agent_id"\)/);
  assert.match(schema, /assignedMemberId: uuid\("assigned_member_id"\)/);
  assert.match(schema, /tasks_single_assignee/);
});

test("agent claiming cannot take human or other-agent work", () => {
  const service = read("src/lib/openclaw/tasks.ts");
  assert.match(service, /t\.assigned_member_id IS NULL/);
  assert.match(service, /t\.assigned_agent_id IS NULL OR t\.assigned_agent_id =/);
  assert.match(service, /t\.lease_until IS NULL/);
  assert.match(service, /assigned_member_id = NULL/);
});

test("operator and MCP surfaces expose unified assignment without removing compatibility", () => {
  const projects = read("src/app/(app)/projects/projects-client.tsx");
  const dashboard = read("src/app/(app)/page.tsx");
  const apiDocs = read("src/content/docs/v1.1/api-reference.md");

  assert.match(projects, /Search people and agents/);
  assert.match(projects, /Assigned to me/);
  assert.match(dashboard, /Dashboard work filter/);
  assert.match(dashboard, /People/);
  assert.match(apiDocs, /assignedAgentId/);
  assert.match(apiDocs, /assignedMemberId/);
  assert.match(apiDocs, /new clients should prefer `assignee`/);
});
