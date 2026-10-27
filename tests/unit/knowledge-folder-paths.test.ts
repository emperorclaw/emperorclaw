import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultResourceFolderFor,
  parseResourceFolderPath,
  RESOURCE_PATH_MAX_DEPTH,
  RESOURCE_PATH_MAX_LENGTH,
  RESOURCE_PATH_MAX_SEGMENT,
  resourceFolderMatchKey,
  resourceFolderOwner,
  resourceFolderSegment,
} from "../../src/lib/resource-paths";

function parsed(input: unknown) {
  const result = parseResourceFolderPath(input);
  assert.equal(result.ok, true, `expected ${JSON.stringify(input)} to parse`);
  return (result as { path: string }).path;
}

function rejected(input: unknown) {
  const result = parseResourceFolderPath(input);
  assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to be rejected`);
  return (result as { error: string }).error;
}

test("parseResourceFolderPath trims, collapses slashes and whitespace", () => {
  assert.equal(parsed("Clients/Harbor Dental/Meetings"), "Clients/Harbor Dental/Meetings");
  assert.equal(parsed("  /Clients//Harbor   Dental/ Meetings / "), "Clients/Harbor Dental/Meetings");
  assert.equal(parsed("Company/"), "Company");
});

test("parseResourceFolderPath maps empty input and a bare slash to the vault root", () => {
  assert.equal(parsed(""), "");
  assert.equal(parsed("/"), "");
  assert.equal(parsed(" // "), "");
});

test("parseResourceFolderPath rejects traversal instead of silently dropping it", () => {
  assert.match(rejected("Clients/../Company"), /"\.\."/);
  assert.match(rejected("../Company"), /"\.\."/);
  assert.match(rejected("Clients/./Acme"), /"\."/);
});

test("parseResourceFolderPath rejects backslashes, control characters and non-strings", () => {
  assert.match(rejected("Clients\\Acme"), /"\/"/);
  assert.match(rejected("Clients/Ac\u0000me"), /control/);
  assert.match(rejected("Clients/Ac\nme"), /control/);
  rejected(42);
  rejected(null);
  rejected({ path: "Company" });
});

test("parseResourceFolderPath enforces depth, segment and total length limits", () => {
  const deepest = Array.from({ length: RESOURCE_PATH_MAX_DEPTH }, (_, i) => `L${i}`).join("/");
  assert.equal(parsed(deepest), deepest);
  assert.match(rejected(`${deepest}/one-more`), /too deep/);

  assert.equal(parsed("a".repeat(RESOURCE_PATH_MAX_SEGMENT)).length, RESOURCE_PATH_MAX_SEGMENT);
  assert.match(rejected("a".repeat(RESOURCE_PATH_MAX_SEGMENT + 1)), /too long/);

  const long = Array.from({ length: 4 }, () => "b".repeat(70)).join("/");
  assert.ok(long.length > RESOURCE_PATH_MAX_LENGTH);
  assert.match(rejected(long), /too long/);
  assert.match(rejected("x".repeat(5000)), /too long/);
});

test("resourceFolderSegment keeps a record name as one folder", () => {
  assert.equal(resourceFolderSegment("Harbor Dental"), "Harbor Dental");
  assert.equal(resourceFolderSegment("  Acme / EU  "), "Acme - EU");
  assert.equal(resourceFolderSegment("a\\b"), "a-b");
  assert.equal(resourceFolderSegment(".."), null);
  assert.equal(resourceFolderSegment("   "), null);
  assert.equal(resourceFolderSegment(undefined), null);
  assert.equal(resourceFolderSegment("x".repeat(200))?.length, RESOURCE_PATH_MAX_SEGMENT);
});

test("resourceFolderOwner reads the Customers/Clients/Projects convention", () => {
  assert.deepEqual(resourceFolderOwner("Customers/Harbor Dental/Meetings"), { kind: "customer", name: "Harbor Dental" });
  assert.deepEqual(resourceFolderOwner("clients/Harbor Dental"), { kind: "customer", name: "Harbor Dental" });
  assert.deepEqual(resourceFolderOwner("Projects/Website relaunch"), { kind: "project", name: "Website relaunch" });
  assert.equal(resourceFolderOwner("Customers"), null);
  assert.equal(resourceFolderOwner("Company/Legal"), null);
  assert.equal(resourceFolderOwner(""), null);
});

test("defaultResourceFolderFor files into the customer's/project's folder only when the vault uses the convention", () => {
  const vault = ["Company", "Customers", "Projects/Old project", "Agents/Playbooks"];
  assert.equal(defaultResourceFolderFor({ scopeType: "customer", ownerName: "Harbor Dental", existingPaths: vault }), "Customers/Harbor Dental");
  assert.equal(defaultResourceFolderFor({ scopeType: "project", ownerName: "Website relaunch", existingPaths: vault }), "Projects/Website relaunch");

  // No convention in this vault: keep today's behaviour (root).
  assert.equal(defaultResourceFolderFor({ scopeType: "customer", ownerName: "Harbor Dental", existingPaths: ["Company", "Ops"] }), null);
  // Company/agent notes have no owner folder.
  assert.equal(defaultResourceFolderFor({ scopeType: "company", ownerName: "x", existingPaths: vault }), null);
  assert.equal(defaultResourceFolderFor({ scopeType: "customer", ownerName: "", existingPaths: vault }), null);
});

test("defaultResourceFolderFor reuses the vault's own casing and a Clients root", () => {
  assert.equal(
    defaultResourceFolderFor({ scopeType: "customer", ownerName: "harbor dental", existingPaths: ["Customers/Harbor Dental/Meetings"] }),
    "Customers/Harbor Dental",
  );
  assert.equal(
    defaultResourceFolderFor({ scopeType: "customer", ownerName: "Harbor Dental", existingPaths: ["clients/Acme"] }),
    "clients/Harbor Dental",
  );
});

test("convention matching folds compatibility forms and case (NFKC + lowercase)", () => {
  assert.equal(resourceFolderMatchKey("Ｃｕｓｔｏｍｅｒｓ"), "customers");
  assert.equal(resourceFolderMatchKey("ﬁnance"), "finance");
  assert.deepEqual(resourceFolderOwner("Ｃｕｓｔｏｍｅｒｓ/Harbor Dental"), { kind: "customer", name: "Harbor Dental" });
  assert.deepEqual(resourceFolderOwner("ＰＲＯＪＥＣＴＳ/Site"), { kind: "project", name: "Site" });
  assert.equal(
    defaultResourceFolderFor({ scopeType: "customer", ownerName: "Harbor Dental", existingPaths: ["Ｃｕｓｔｏｍｅｒｓ/Acme"] }),
    "Ｃｕｓｔｏｍｅｒｓ/Harbor Dental",
  );
});
