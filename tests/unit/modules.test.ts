import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    ALL_MODULES_ON, COMPANY_TEMPLATES, MODULES, MODULE_KEYS, MODULE_TOOLS, isCompanyTemplateId, isModuleKey,
    moduleForPath, moduleForTool, moduleOffMessage, pathEnabled, resolveModules, templateModules, type ModuleState,
} from "../../src/lib/modules";
import { activeNavHref, mobileTabs, navSections } from "../../src/lib/navigation";
import { settingsSections } from "../../src/lib/settings-navigation";
import { EMPEROR_MANUAL, emperorManualSectionsFor, formatEmperorManual } from "../../src/lib/emperor-manual";
import { formatAuditValue, redactAuditPayload } from "../../src/lib/audit-format";

const off = (...keys: string[]): ModuleState => ({ ...ALL_MODULES_ON, ...Object.fromEntries(keys.map((k) => [k, false])) });
const admin = { isCompanyAdmin: true, isPlatformAdmin: false };

test("a company with nothing stored (every existing company) has every module on", () => {
    assert.deepEqual(resolveModules({}), ALL_MODULES_ON);
    assert.deepEqual(resolveModules(null), ALL_MODULES_ON);
    assert.deepEqual(resolveModules("garbage"), ALL_MODULES_ON);
    assert.deepEqual(resolveModules([false]), ALL_MODULES_ON);
    // Only an explicit false turns a module off; unknown keys are ignored.
    assert.deepEqual(resolveModules({ views: false, customers: "no", nope: false }), off("views"));
});

test("templates set the starting modules", () => {
    assert.deepEqual(templateModules("agency"), ALL_MODULES_ON);
    assert.deepEqual(templateModules("product"), off("customers"));
    const operations = templateModules("operations");
    assert.equal(operations.approvals, true);
    assert.equal(operations.automations, true);
    assert.deepEqual(MODULE_KEYS.filter((k) => operations[k]).sort(), ["approvals", "automations"]);
    assert.ok(isCompanyTemplateId("agency") && !isCompanyTemplateId("enterprise"));
    assert.deepEqual(COMPANY_TEMPLATES.map((t) => t.id), ["agency", "product", "operations"]);
});

test("every module has a label and a one-line description; keys are recognised", () => {
    assert.deepEqual(MODULES.map((m) => m.key), [...MODULE_KEYS]);
    for (const m of MODULES) {
        assert.ok(m.label && m.description && !m.description.includes("\n"), m.key);
        assert.ok(isModuleKey(m.key));
    }
    assert.equal(isModuleKey("knowledge"), false);
    assert.match(moduleOffMessage("views"), /Views module is off.*Settings → Modules/);
});

test("paths map to their module; core pages never do", () => {
    assert.equal(moduleForPath("/customers"), "customers");
    assert.equal(moduleForPath("/views/abc?x=1"), "views");
    assert.equal(moduleForPath("/budgets"), "costs");
    assert.equal(moduleForPath("/pipelines"), "automations");
    assert.equal(moduleForPath("/viewsx"), null);
    assert.equal(moduleForPath("/projects"), null);
    assert.equal(moduleForPath("/inbox"), null);
    assert.equal(pathEnabled("/views", off("views")), false);
    assert.equal(pathEnabled("/views", null), true);
    assert.equal(pathEnabled("/projects", off(...MODULE_KEYS)), true);
});

test("nav: a module that is off loses its entries everywhere; omitted modules = all on", () => {
    const hrefs = (modules?: ModuleState) => navSections({ ...admin, modules }).flatMap((s) => s.items).map((i) => i.href);
    assert.deepEqual(hrefs(), hrefs(ALL_MODULES_ON));
    const none = hrefs(off(...MODULE_KEYS));
    for (const href of ["/customers", "/pipelines", "/timeline", "/costs", "/views"]) {
        assert.ok(hrefs().includes(href), `${href} shown when on`);
        assert.ok(!none.includes(href), `${href} hidden when off`);
    }
    // Aliases into a module that is off go too: /approvals no longer lights up Inbox.
    const items = navSections({ ...admin, modules: off("approvals") }).flatMap((s) => s.items);
    assert.equal(activeNavHref("/approvals", items), null);
    assert.equal(activeNavHref("/approvals", navSections(admin).flatMap((s) => s.items)), "/inbox");
    // A section left with no items disappears (Clients & knowledge keeps Knowledge base).
    for (const s of navSections({ ...admin, modules: off(...MODULE_KEYS) })) assert.ok(s.items.length > 0);
});

test("mobile tabs stay five; only aliases into modules that are off drop", () => {
    const tabs = mobileTabs(off("costs", "approvals"));
    assert.deepEqual(tabs.map((t) => t.name), ["Home", "Inbox", "Messages", "Projects", "Agents"]);
    assert.deepEqual(tabs.find((t) => t.id === "agents")?.activeFor, []);
    assert.deepEqual(tabs.find((t) => t.id === "inbox")?.activeFor, []);
    assert.deepEqual(mobileTabs().find((t) => t.id === "agents")?.activeFor, ["/budgets", "/costs"]);
});

test("settings: Modules is an admin tab; Displays hides with its module", () => {
    const ids = (modules?: ModuleState, isAdmin = true) => settingsSections({ isAdmin, instanceAdmin: false, modules }).flatMap((s) => s.items.map((i) => i.id));
    assert.ok(ids().includes("modules") && ids().includes("displays"));
    assert.ok(!ids(undefined, false).includes("modules"));
    assert.ok(!ids(off("displays")).includes("displays"));
});

test("agent tools: Views tools belong to the Views module, request_approval to none", () => {
    const source = readFileSync(path.join(__dirname, "..", "..", "src", "lib", "mcp-server", "tools", "views.ts"), "utf8");
    const registered = [...source.matchAll(/registerTool\("([a-z_]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual([...(MODULE_TOOLS.views ?? [])].sort(), registered);
    for (const tool of registered) assert.equal(moduleForTool(tool), "views");
    assert.equal(moduleForTool("request_approval"), null);
    assert.equal(moduleForTool("create_task"), null);
});

test("manual: lines about a module that is off are left out", () => {
    assert.equal(formatEmperorManual(emperorManualSectionsFor(null)), EMPEROR_MANUAL);
    assert.equal(formatEmperorManual(emperorManualSectionsFor(ALL_MODULES_ON)), EMPEROR_MANUAL);
    const without = formatEmperorManual(emperorManualSectionsFor(off("views")));
    assert.ok(EMPEROR_MANUAL.includes("create_view"));
    assert.ok(!without.includes("create_view") && !without.includes("update_panel"));
    assert.ok(without.length < EMPEROR_MANUAL.length);
    assert.ok(without.includes("request_approval"), "approvals guidance stays");
});

test("audit: module changes keep their on/off fields and render as on/off", () => {
    const payload = redactAuditPayload("company", { before: { viewsModule: true, secret: "x" }, after: { viewsModule: false }, meta: { setting: "modules", template: "product" } });
    assert.deepEqual(payload.before, { viewsModule: true });
    assert.deepEqual(payload.after, { viewsModule: false });
    assert.equal(payload.meta?.template, "product");
    assert.equal(formatAuditValue("viewsModule", false), "off");
    assert.equal(formatAuditValue("viewsModule", true), "on");
});
