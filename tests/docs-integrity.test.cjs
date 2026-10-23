/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync, readdirSync, existsSync } = require("node:fs");
const { resolve, join } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");
const versionsSource = readFileSync(resolve(root, "src/content/docs/versions.ts"), "utf8");

function listedPages(versionId) {
  const block = versionsSource.split(`id: '${versionId}'`)[1] ?? "";
  const pages = [...block.matchAll(/\{ slug: '([^']+)', title: '[^']+', file: '([^']+)'(?:, section: '([^']+)')? \}/g)];
  return pages.map((m) => ({ slug: m[1], file: m[2], section: m[3] }));
}

test("every docs page in the nav has a file, and every file is in the nav", () => {
  const versionIds = [...versionsSource.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(versionIds.length > 0);
  for (const id of versionIds) {
    const dir = resolve(root, "src/content/docs", id);
    assert.ok(existsSync(dir), `docs folder for ${id} exists`);
    const pages = listedPages(id);
    for (const page of pages) {
      assert.ok(existsSync(join(dir, page.file)), `${id}/${page.file} is listed in the nav but missing`);
      assert.ok(page.section, `${id}/${page.slug} has a sidebar section`);
    }
    const listed = new Set(pages.map((p) => p.file));
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      assert.ok(listed.has(file), `${id}/${file} exists but is not in the nav`);
    }
  }
});

test("links between docs pages point at pages that exist", () => {
  const slugs = new Set(listedPages("v1.1").map((p) => p.slug));
  const dir = resolve(root, "src/content/docs/v1.1");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const m of text.matchAll(/\]\((?:\/docs\/v1\.1\/|\.\/)([a-z0-9-]+)/g)) {
      assert.ok(slugs.has(m[1]), `${file} links to missing page ${m[1]}`);
    }
  }
});

test("docs text has no mis-encoded characters", () => {
  const dir = resolve(root, "src/content/docs/v1.1");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(dir, file), "utf8");
    assert.ok(!/â€|Â©|Â·|Ã©/.test(text), `${file} contains mojibake`);
  }
});

test("light mode doesn't use standard-scale zinc pairs (the scale is inverted)", () => {
  const renderer = readFileSync(resolve(root, "src/components/docs-markdown-renderer.tsx"), "utf8");
  assert.ok(!/text-zinc-[6-9]00 dark:text-zinc/.test(renderer), "docs text must read in both themes");
  const css = readFileSync(resolve(root, "src/app/globals.css"), "utf8");
  assert.ok(css.includes("select option"), "native dropdown options follow the theme");
});

test("Hermes docs only use emperor-hermes commands the installer has", () => {
  const installer = readFileSync(resolve(root, "integrations/hermes/install/emperor-hermes.sh"), "utf8");
  const dispatch = installer.slice(installer.indexOf('case "$cmd" in'));
  const commands = new Set([...dispatch.matchAll(/^\s+([a-z-]+)(?: \| [a-z-]+)*\)/gm)].map((m) => m[1]));
  for (const cmd of ["install", "migrate", "update", "rollback", "status", "doctor", "finalize", "restart-gateway"]) {
    assert.ok(commands.has(cmd), `installer dispatches ${cmd}`);
  }
  const docs = [
    "src/content/docs/v1.1/hermes-runtime.md",
    "src/content/docs/v1.1/hermes-migration-0.9.md",
    "integrations/hermes/emperor-claw/README.md",
  ];
  for (const file of docs) {
    const text = readFileSync(resolve(root, file), "utf8");
    for (const m of text.matchAll(/\bemperor-hermes ([a-z][a-z-]*)/g)) {
      if (["gateway", "bridge", "logrotate"].includes(m[1])) continue; // unit names, not commands
      assert.ok(commands.has(m[1]), `${file} uses unknown command "emperor-hermes ${m[1]}"`);
    }
  }
});

test("the installer pins the same Hermes commit as the server", () => {
  const installer = readFileSync(resolve(root, "integrations/hermes/install/emperor-hermes.sh"), "utf8");
  const sha = installer.match(/^readonly HERMES_SHA="([0-9a-f]{40})"/m)?.[1];
  const ref = installer.match(/^readonly HERMES_REF="([^"]+)"/m)?.[1];
  assert.ok(sha && ref, "installer declares HERMES_REF and HERMES_SHA");
  const server = readFileSync(resolve(root, "src/lib/hermes-bridge-version.ts"), "utf8");
  assert.ok(server.includes(`"${sha}"`), "PINNED_HERMES_SHA matches the installer");
  assert.ok(server.includes(`"${ref}"`), "PINNED_HERMES_VERSION matches the installer");
});
