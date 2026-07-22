import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildResourceFolderTree,
  DEFAULT_CONTEXT_MAX_CHARS_PER_RESOURCE,
  normalizeResourcePath,
  resolveMaxCharsPerResource,
  RESOURCE_PATH_MAX_DEPTH,
} from "../../src/lib/resources";

test("normalizeResourcePath accepts the shapes people actually type", () => {
  assert.equal(normalizeResourcePath("Company/Fundraising"), "Company/Fundraising");
  assert.equal(normalizeResourcePath("/Ferrari/XXX"), "Ferrari/XXX");
  assert.equal(normalizeResourcePath("Company/Fundraising/"), "Company/Fundraising");
  assert.equal(normalizeResourcePath("  /Company//Fundraising//  "), "Company/Fundraising");
});

test("normalizeResourcePath treats empty-ish input as the vault root", () => {
  assert.equal(normalizeResourcePath(""), "");
  assert.equal(normalizeResourcePath("   "), "");
  assert.equal(normalizeResourcePath("///"), "");
  assert.equal(normalizeResourcePath(null), "");
  assert.equal(normalizeResourcePath(undefined), "");
  assert.equal(normalizeResourcePath(42), "");
});

test("normalizeResourcePath drops traversal segments", () => {
  // ".." must not survive: paths feed prefix queries, so a traversal segment
  // would let a note claim membership of a folder above its own.
  assert.equal(normalizeResourcePath("Company/../Secret"), "Company/Secret");
  assert.equal(normalizeResourcePath("../../etc"), "etc");
  assert.equal(normalizeResourcePath("./Company"), "Company");
});

test("normalizeResourcePath collapses inner whitespace but keeps spaces in names", () => {
  assert.equal(normalizeResourcePath("Ferrari   Racing/Q1   Audits"), "Ferrari Racing/Q1 Audits");
});

test("normalizeResourcePath caps depth", () => {
  const deep = Array.from({ length: RESOURCE_PATH_MAX_DEPTH + 5 }, (_, i) => `l${i}`).join("/");
  assert.equal(normalizeResourcePath(deep).split("/").length, RESOURCE_PATH_MAX_DEPTH);
});

test("buildResourceFolderTree materializes intermediate folders", () => {
  // "A/B/C" must produce A and A/B even though neither holds a note directly.
  const tree = buildResourceFolderTree([{ path: "A/B/C" }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].path, "A");
  assert.equal(tree[0].directCount, 0);
  assert.equal(tree[0].totalCount, 1);
  assert.equal(tree[0].children[0].path, "A/B");
  assert.equal(tree[0].children[0].children[0].path, "A/B/C");
  assert.equal(tree[0].children[0].children[0].directCount, 1);
});

test("buildResourceFolderTree separates direct from rolled-up counts", () => {
  const tree = buildResourceFolderTree([
    { path: "Company" },
    { path: "Company/Fundraising" },
    { path: "Company/Fundraising" },
    { path: "Ferrari/Audits" },
  ]);

  const company = tree.find((node) => node.path === "Company");
  assert.ok(company);
  assert.equal(company.directCount, 1);
  assert.equal(company.totalCount, 3);

  const fundraising = company.children.find((node) => node.path === "Company/Fundraising");
  assert.ok(fundraising);
  assert.equal(fundraising.directCount, 2);
  assert.equal(fundraising.name, "Fundraising");

  // Root-level folders are sorted by name.
  assert.deepEqual(tree.map((node) => node.name), ["Company", "Ferrari"]);
});

test("buildResourceFolderTree ignores root-level notes", () => {
  const tree = buildResourceFolderTree([{ path: "" }, { path: null }, { path: undefined }]);
  assert.deepEqual(tree, []);
});

test("resolveMaxCharsPerResource honours the env override", () => {
  const original = process.env.EMPEROR_BRAIN_MAX_CHARS_PER_RESOURCE;
  try {
    delete process.env.EMPEROR_BRAIN_MAX_CHARS_PER_RESOURCE;
    assert.equal(resolveMaxCharsPerResource(), DEFAULT_CONTEXT_MAX_CHARS_PER_RESOURCE);

    process.env.EMPEROR_BRAIN_MAX_CHARS_PER_RESOURCE = "20000";
    assert.equal(resolveMaxCharsPerResource(), 20000);

    // Garbage and non-positive values fall back rather than truncating to nothing.
    for (const bad of ["", "abc", "0", "-5"]) {
      process.env.EMPEROR_BRAIN_MAX_CHARS_PER_RESOURCE = bad;
      assert.equal(resolveMaxCharsPerResource(), DEFAULT_CONTEXT_MAX_CHARS_PER_RESOURCE, `input: ${bad}`);
    }
  } finally {
    if (original === undefined) delete process.env.EMPEROR_BRAIN_MAX_CHARS_PER_RESOURCE;
    else process.env.EMPEROR_BRAIN_MAX_CHARS_PER_RESOURCE = original;
  }
});

test("the per-resource default is large enough for a real doctrine note", () => {
  // Regression guard: at the old hard-coded 3000 an 8k doctrine was silently
  // cut off mid-document and agents acted on rules they never received.
  assert.ok(DEFAULT_CONTEXT_MAX_CHARS_PER_RESOURCE >= 8000);
});
