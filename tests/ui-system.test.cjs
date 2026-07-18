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

test("App shell exposes the standardized Emperor visual system", () => {
  const rootLayout = read("src/app/layout.tsx");
  assertContains(rootLayout, "Geist", "root layout should use the professional app font (Geist)");

  const appLayout = read("src/app/(app)/layout.tsx");
  ["emperor-app-shell", "emperor-main", "emperor-page-frame"].forEach((needle) => {
    assertContains(appLayout, needle, `app shell should include ${needle}`);
  });

  const globals = read("src/app/globals.css");
  ["emperor-panel", "emperor-chip", "prefers-reduced-motion", "color-scheme: dark", "radial-gradient"].forEach((needle) => {
    assertContains(globals, needle, `global visual system should include ${needle}`);
  });
});

test("Shared UI primitives use the professional dark system", () => {
  const files = [
    "src/components/ui/button.tsx",
    "src/components/ui/card.tsx",
    "src/components/ui/input.tsx",
    "src/components/ui/badge.tsx",
    "src/components/ui/textarea.tsx",
    "src/components/ui/table.tsx",
    "src/components/ui/dialog.tsx",
  ];

  files.forEach((file) => {
    const source = read(file);
    assertContains(source, "zinc", `${file} should use the standardized zinc surface scale`);
  });

  const sidebar = read("src/components/app-sidebar.tsx");
  assertContains(sidebar, "md:w-64", "sidebar should keep mobile navigation as a compact rail");
  assertContains(sidebar, "text-cyan-300", "sidebar should use the standardized accent color");
});
