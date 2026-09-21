/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

test("RoleTemplatePicker keeps the Custom card outside the scrollable grid", () => {
  const source = read("src/app/(app)/agents/role-template-picker.tsx");
  const scrollStart = source.indexOf("overflow-y-auto");
  const customStart = source.indexOf("allowCustom && (");
  assert.ok(scrollStart !== -1, "the template grid should be scrollable");
  assert.ok(customStart !== -1, "the picker should offer a custom option");
  assert.ok(scrollStart < customStart, "the custom card should render after the scroll grid");
  const scrollRegion = source.slice(scrollStart, customStart);
  assert.ok(scrollRegion.includes("agentRoleTemplates.map"), "the scroll region should hold the templates");
  assert.ok(!scrollRegion.includes("onSelect(null)"), "the custom card must not live inside the scroll region");
});

test("Clickable controls advertise a pointer cursor", () => {
  const picker = read("src/app/(app)/agents/role-template-picker.tsx");
  const pointerCount = (picker.match(/cursor-pointer/g) || []).length;
  assert.ok(pointerCount >= 2, "both role card variants should use cursor-pointer");
  const globals = read("src/app/globals.css");
  assert.ok(globals.includes("button:not(:disabled)"), "buttons should default to a pointer cursor");
});
