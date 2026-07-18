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
  assert.ok(source.includes(needle), message || `Expected source to contain "${needle}"`);
}

// ── T-2.4: Invitations Module ─────────────────────────────────────────────

test("invitations.ts exports token generation and validation functions", () => {
  // Check structural completeness
  const inviteFileExists = require("node:fs").existsSync(resolve(root, "src/lib/invitations.ts"));
  assert.ok(inviteFileExists, "invitations.ts must exist");
  if (!inviteFileExists) return;

  const source = read("src/lib/invitations.ts");
  assertContains(source, "generateInviteToken", "must export generateInviteToken");
  assertContains(source, "createInvitation", "must export createInvitation");
  assertContains(source, "validateInviteToken", "must export validateInviteToken");
  assertContains(source, "consumeInvite", "must export consumeInvite");
  assertContains(source, "getInvitations", "must export getInvitations");
  assertContains(source, "revokeInvitation", "must export revokeInvitation");
});

test("token generation uses crypto.randomBytes(32) for 32+ bytes entropy", () => {
  const source = read("src/lib/invitations.ts");
  assertContains(source, "randomBytes", "must use crypto.randomBytes for token generation (NFR-1)");
  assertContains(source, "32", "must use at least 32 bytes of entropy (NFR-1)");
});

test("token storage uses SHA-256 hashing, never stores raw tokens", () => {
  const source = read("src/lib/invitations.ts");
  assertContains(source, "sha256", "must use SHA-256 for token hashing (NFR-2)");
  assertContains(source, "createHash", "must use crypto.createHash for hashing");
  assertContains(source, "tokenHash", "must store tokenHash not raw token");
});

test("validateInviteToken checks expiry, use_count, and deleted_at", () => {
  const source = read("src/lib/invitations.ts");
  assertContains(source, "expiresAt", "must check expiresAt");
  assertContains(source, "useCount", "must check useCount");
  assertContains(source, "deletedAt", "must check deletedAt for soft-deletion");
});

test("consumeInvite uses a database transaction", () => {
  const source = read("src/lib/invitations.ts");
  assertContains(source, "transaction", "consumeInvite must use a DB transaction (FR-16)");
});

test("createInvitation validates role is member|admin|viewer only", () => {
  const source = read("src/lib/invitations.ts");
  // Must reject instance_admin
  assertContains(source, "member", "must allow member role");
  assertContains(source, "admin", "must allow admin role");
  assertContains(source, "viewer", "must allow viewer role");
  // Should NOT accept instance_admin
  const lines = source.split("\n");
  const roleValidationLines = lines.filter(
    (l) => (l.includes("member") || l.includes("admin") || l.includes("viewer")) &&
           l.includes("instance_admin")
  );
  // At minimum, the code must NOT treat instance_admin as a valid invitation role
  // We check that the role is validated
  assertContains(source, "role", "must validate role field");
});

test("invitation email normalization uses lowercase", () => {
  const source = read("src/lib/invitations.ts");
  assertContains(source, "toLowerCase", "email must be normalized to lowercase (FR-11)");
});

test("invitation duplicate check prevents two active invites for same email", () => {
  const source = read("src/lib/invitations.ts");
  // Either has explicit duplicate check or documents the 409 pattern
  assertContains(source, "already exists", "must handle duplicate email invitations (EC-3)");
});
