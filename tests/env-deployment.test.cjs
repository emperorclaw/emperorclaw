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
  assert.ok(source.includes(needle), message || `Expected source to contain "${needle}"`);
}

function assertFile(relativePath) {
  assert.ok(existsSync(resolve(root, relativePath)), `${relativePath} should exist`);
}

// ── T-1.1: Migration SQL ──────────────────────────────────────────────────

test("team-rbac migration file exists with expected DDL", () => {
  assertFile("src/db/migrations/0024_team-rbac.sql");
  const sql = read("src/db/migrations/0024_team-rbac.sql");

  // New tables
  assertContains(sql, "CREATE TABLE IF NOT EXISTS", "migration must use IF NOT EXISTS (idempotent)");
  assertContains(sql, '"invitations"', "migration must create invitations table");
  assertContains(sql, '"instance_settings"', "migration must create instance_settings table");

  // invitations columns
  assertContains(sql, "company_id", "invitations must have company_id");
  assertContains(sql, "created_by_user_id", "invitations must have created_by_user_id");
  assertContains(sql, "email", "invitations must have email");
  assertContains(sql, "token_hash", "invitations must have token_hash");
  assertContains(sql, "role", "invitations must have role");
  assertContains(sql, "max_uses", "invitations must have max_uses");
  assertContains(sql, "use_count", "invitations must have use_count");
  assertContains(sql, "expires_at", "invitations must have expires_at");

  // instance_settings columns
  assertContains(sql, "jsonb", "instance_settings value must be jsonb");
  assertContains(sql, "PRIMARY KEY", "instance_settings key must be primary key");

  // Modify existing tables (idempotent)
  assertContains(sql, "ALTER TABLE", "migration must alter existing tables");
  assertContains(sql, '"users"', "migration must alter users table");
  assertContains(sql, "instance_role", "migration must add instance_role column");
  assertContains(sql, "ADD COLUMN IF NOT EXISTS", "migration must use IF NOT EXISTS for column addition");

  // Auto-migration for existing deployments (NFR-11)
  assertContains(sql, "UPDATE", "migration must auto-migrate existing users");
  assertContains(sql, "instance_admin", "migration must assign instance_admin to existing sole creator");
  assertContains(sql, "created_by_user_id", "migration must detect sole company creator");

  // No destructive operations
  assert.equal(sql.includes("DROP COLUMN"), false, "migration must not drop columns (NFR-10)");
  assert.equal(sql.includes("DELETE FROM"), false, "migration must not delete data (NFR-10)");
});

// ── T-1.2: Schema exports ─────────────────────────────────────────────────

test("Drizzle schema exports new RBAC tables", () => {
  const schema = read("src/db/schema.ts");
  assertContains(schema, "export const invitations", "schema.ts must export invitations table");
  assertContains(schema, "export const instanceSettings", "schema.ts must export instanceSettings table");
  assertContains(schema, "instance_role", "users table must include instance_role column");
  assertContains(schema, 'default("member")', "companyMembers.role default must change to member");
});

// ── T-2.1: DEPLOYMENT_MODE env var ────────────────────────────────────────

test("env.ts exports DEPLOYMENT_MODE with self-hosted default", () => {
  const envSource = read("src/lib/env.ts");
  assertContains(envSource, "DEPLOYMENT_MODE", "env.ts must export DEPLOYMENT_MODE");
  assertContains(envSource, "self-hosted", "DEPLOYMENT_MODE must default to self-hosted");
  assertContains(envSource, "cloud", "DEPLOYMENT_MODE must support cloud value");
  // Must be a const export (read at module load, not a function — NFR-4)
  assertContains(envSource, "export const DEPLOYMENT_MODE", "DEPLOYMENT_MODE must be a const export");
});

// ── T-7.2: .env.example updated ───────────────────────────────────────────

test(".env.example includes DEPLOYMENT_MODE", () => {
  const envExample = read(".env.example");
  assertContains(envExample, "DEPLOYMENT_MODE", ".env.example must document DEPLOYMENT_MODE");
  assertContains(envExample, "self-hosted", ".env.example must mention self-hosted default");
});

// ── T-5.4: Sidebar navigation ────────────────────────────────────────────

test("Members moved from sidebar to Settings tab", () => {
  const sidebar = read("src/components/app-sidebar.tsx");
  // Members was intentionally moved inside Settings for cleaner nav
  // It should NOT appear in the sidebar nav directly
  assert(!sidebar.includes('url: "/settings/members"'),
    "sidebar should not contain Members nav link — it lives under Settings now");
  assertContains(read("src/app/(app)/settings/settings-client.tsx"), "Members",
    "settings-client must expose Members to admin+ roles");
});

// ── T-7.1: Role-based UI visibility ───────────────────────────────────────

test("projects header hides New Project button for viewer role", () => {
  const projects = read("src/app/(app)/projects/projects-client.tsx");
  // The component must at minimum provide the capability to hide based on role
  assertContains(projects, "companyRole", "projects-client must reference companyRole for role-based visibility");
});

test("settings page hides token generation for viewer and member roles", () => {
  const settingsClient = read("src/app/(app)/settings/settings-client.tsx");
  assertContains(settingsClient, "companyRole", "settings-client must reference companyRole for permission checks");
});
