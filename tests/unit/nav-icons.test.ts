import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { navSections } from "../../src/lib/navigation";

// The sidebar falls back to the folder icon, so a nav item missing from NAV_ICONS
// silently looks like Projects. Every item gets its own icon.
test("every sidebar item has its own icon", () => {
    const source = readFileSync("src/components/app-sidebar.tsx", "utf8");
    const map = source.slice(source.indexOf("const NAV_ICONS"), source.indexOf("};", source.indexOf("const NAV_ICONS")));
    const icons = new Map([...map.matchAll(/^\s+(\w+): (Icon\w+),/gm)].map((m) => [m[1], m[2]]));
    const items = navSections({ isCompanyAdmin: true, isPlatformAdmin: true }).flatMap((section) => section.items);
    for (const item of items) assert.ok(icons.has(item.id), `${item.id} has no icon in NAV_ICONS`);
    const used = items.map((item) => icons.get(item.id));
    assert.equal(new Set(used).size, used.length, `two sidebar items share an icon: ${used.join(", ")}`);
});
