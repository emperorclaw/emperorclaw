import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { activeNavHref, MOBILE_TABS, navSections, readCollapsedSections } from "../../src/lib/navigation";

const APP_DIR = path.join(__dirname, "..", "..", "src", "app", "(app)");

function pageExists(href: string): boolean {
    const route = href.split("?")[0].replace(/^\//, "");
    return existsSync(path.join(APP_DIR, route, "page.tsx"));
}

const everyone = [
    { isCompanyAdmin: false, isPlatformAdmin: false },
    { isCompanyAdmin: true, isPlatformAdmin: false },
    { isCompanyAdmin: true, isPlatformAdmin: true },
];

test("every nav href resolves to an existing page.tsx", () => {
    for (const access of everyone) {
        for (const item of navSections(access).flatMap((s) => s.items)) {
            assert.ok(pageExists(item.href), `${item.name} -> ${item.href} has no page`);
            for (const alias of item.activeFor ?? []) assert.ok(pageExists(alias), `${item.name} alias ${alias} has no page`);
        }
    }
    for (const tab of MOBILE_TABS) assert.ok(pageExists(tab.href), `tab ${tab.name} -> ${tab.href}`);
});

test("the attention cluster comes first and no section is empty", () => {
    for (const access of everyone) {
        const sections = navSections(access);
        assert.deepEqual(sections[0].items.map((i) => i.name), ["Home", "Inbox", "Messages"]);
        for (const s of sections) assert.ok(s.items.length > 0, `${s.id} is empty`);
    }
});

test("admin rows only for admins; Admin starts collapsed", () => {
    const member = navSections({ isCompanyAdmin: false, isPlatformAdmin: false });
    assert.equal(member.some((s) => s.id === "admin"), false);
    assert.equal(member.flatMap((s) => s.items).some((i) => i.id === "people"), false);
    const admin = navSections({ isCompanyAdmin: true, isPlatformAdmin: true });
    const adminSection = admin.find((s) => s.id === "admin");
    assert.equal(adminSection?.defaultCollapsed, true);
    assert.deepEqual(adminSection?.items.map((i) => i.href), ["/budgets", "/ops"]);
});

test("mobile tabs: Home, Inbox, Messages, Projects, Agents", () => {
    assert.deepEqual(MOBILE_TABS.map((t) => t.name), ["Home", "Inbox", "Messages", "Projects", "Agents"]);
});

test("one active item, the most specific match", () => {
    const items = navSections({ isCompanyAdmin: true, isPlatformAdmin: false }).flatMap((s) => s.items);
    assert.equal(activeNavHref("/", items), "/");
    assert.equal(activeNavHref("/agents/organization", items), "/agents/organization");
    assert.equal(activeNavHref("/agents/123", items), "/agents");
    assert.equal(activeNavHref("/settings/members", items), "/settings/members");
    assert.equal(activeNavHref("/approvals", items), "/inbox", "approvals is the inbox's filter");
    assert.equal(activeNavHref("/budgets", items), "/budgets");
    const memberItems = navSections({ isCompanyAdmin: false, isPlatformAdmin: false }).flatMap((s) => s.items);
    assert.equal(activeNavHref("/budgets", memberItems), "/agents", "members reach Costs from Agents");
    assert.equal(activeNavHref("/docs", items), null);
});

test("stored section state tolerates junk", () => {
    assert.deepEqual(readCollapsedSections(null), {});
    assert.deepEqual(readCollapsedSections("not json"), {});
    assert.deepEqual(readCollapsedSections("[1,2]"), {});
    assert.deepEqual(readCollapsedSections('{"work":true,"team":"x","admin":false}'), { work: true, admin: false });
});
