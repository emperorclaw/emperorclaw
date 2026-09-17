import { test } from "node:test";
import assert from "node:assert/strict";
import { canAccessPlatformAdmin } from "../../src/lib/platform-admin-policy";
const instanceAdmin = { deploymentMode: "self-hosted", instanceRole: "instance_admin", email: "Admin@example.com", allowedEmails: [] as string[] };

test("self-hosted instance admins get update controls without an allowlist", () => {
  assert.equal(canAccessPlatformAdmin(instanceAdmin), true);
  assert.equal(canAccessPlatformAdmin({ ...instanceAdmin, instanceRole: "member" }), false);
});
test("cloud and unknown modes require explicit configured platform access", () => {
  assert.equal(canAccessPlatformAdmin({ ...instanceAdmin, deploymentMode: "cloud" }), false);
  assert.equal(canAccessPlatformAdmin({ ...instanceAdmin, deploymentMode: "unknown" }), false);
});
test("an explicit allowlist retains its restrictions", () => {
  assert.equal(canAccessPlatformAdmin({ ...instanceAdmin, allowedEmails: ["someone@example.com"] }), false);
  assert.equal(canAccessPlatformAdmin({ ...instanceAdmin, deploymentMode: "cloud", allowedEmails: ["admin@example.com"] }), true);
});
