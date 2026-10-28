/**
 * Modules: parts of Emperor a company switches on and off (Settings → Modules,
 * docs/roadmap/0.13-plan.md, "0.15: modules and templates"). Client-safe; the
 * server guard is lib/modules-server.ts (moduleEnabled).
 *
 * A module that is off hides its nav entries and pages, its API routes answer
 * 403, and its MCP tools are left out of the agents' tool list. Its data is
 * never touched, so switching it back on restores everything.
 *
 * Approvals is deliberately narrow: "off" hides the Approval history page and
 * nothing else. Approvals are how "ask first" action permissions, project
 * sign-off and request_approval stay safe, so asks still reach the Inbox and
 * agents keep request_approval whatever this setting says.
 */

export const MODULE_KEYS = ["customers", "automations", "timeline", "costs", "approvals", "views", "displays"] as const;
export type ModuleKey = typeof MODULE_KEYS[number];
export type ModuleState = Record<ModuleKey, boolean>;

export type ModuleDefinition = {
    key: ModuleKey;
    label: string;
    description: string;
    /** App routes (and everything under them) that belong to the module. */
    routes: readonly string[];
};

export const MODULES: readonly ModuleDefinition[] = [
    { key: "customers", label: "Customers", description: "Client records, with their projects, knowledge and views grouped per client.", routes: ["/customers"] },
    { key: "automations", label: "Automations", description: "Pipelines and schedules that agents register and run.", routes: ["/pipelines"] },
    { key: "timeline", label: "Timeline", description: "A Gantt chart of who worked on what, and when.", routes: ["/timeline"] },
    { key: "costs", label: "Costs", description: "Spend by client, project, model and agent, with budgets.", routes: ["/costs", "/budgets"] },
    { key: "approvals", label: "Approval history", description: "The page of every approval. When off, asks still reach the Inbox.", routes: ["/approvals"] },
    { key: "views", label: "Views", description: "Dashboards that agents build and keep up to date.", routes: ["/views"] },
    { key: "displays", label: "Display screens", description: "Physical screens that show the live agent feed.", routes: [] },
];

/**
 * MCP tools that exist only for a module. They are not registered (so not
 * listed, and a call is refused) while the module is off. request_approval is
 * not here on purpose: see the Approvals note above.
 */
export const MODULE_TOOLS: Partial<Record<ModuleKey, readonly string[]>> = {
    views: ["list_views", "get_view", "create_view", "update_view", "update_panel", "archive_view"],
};

export const ALL_MODULES_ON: ModuleState = Object.fromEntries(MODULE_KEYS.map((key) => [key, true])) as ModuleState;

export function isModuleKey(value: unknown): value is ModuleKey {
    return typeof value === "string" && (MODULE_KEYS as readonly string[]).includes(value);
}

export function moduleDefinition(key: ModuleKey): ModuleDefinition {
    return MODULES.find((m) => m.key === key)!;
}

/** The stored map (companies.modules_json) as a full state. A missing or malformed key is on. */
export function resolveModules(raw: unknown): ModuleState {
    const stored = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    return Object.fromEntries(MODULE_KEYS.map((key) => [key, stored[key] !== false])) as ModuleState;
}

/** Company templates set the starting modules; choosing one changes nothing else. */
export const COMPANY_TEMPLATES = [
    { id: "agency", label: "Agency", description: "You work for clients. Every module, Customers included.", off: [] },
    { id: "product", label: "Product / solo", description: "You build your own product. Everything except Customers.", off: ["customers"] },
    { id: "operations", label: "Operations", description: "You run processes. Approvals and Automations; the rest stays off until you need it.", off: ["customers", "timeline", "costs", "views", "displays"] },
] as const satisfies readonly { id: string; label: string; description: string; off: readonly ModuleKey[] }[];

export type CompanyTemplateId = typeof COMPANY_TEMPLATES[number]["id"];
export const DEFAULT_COMPANY_TEMPLATE: CompanyTemplateId = "agency";

export function isCompanyTemplateId(value: unknown): value is CompanyTemplateId {
    return typeof value === "string" && COMPANY_TEMPLATES.some((t) => t.id === value);
}

export function templateModules(id: CompanyTemplateId): ModuleState {
    const off = new Set<ModuleKey>(COMPANY_TEMPLATES.find((t) => t.id === id)?.off ?? []);
    return Object.fromEntries(MODULE_KEYS.map((key) => [key, !off.has(key)])) as ModuleState;
}

function underRoute(pathname: string, route: string): boolean {
    const path = pathname.split(/[?#]/)[0];
    return path === route || path.startsWith(`${route}/`);
}

/** The module an app path belongs to, or null for core pages. */
export function moduleForPath(pathname: string): ModuleKey | null {
    return MODULES.find((m) => m.routes.some((route) => underRoute(pathname, route)))?.key ?? null;
}

/** False when the path belongs to a module that is off. `modules` omitted = everything on. */
export function pathEnabled(pathname: string, modules?: ModuleState | null): boolean {
    const key = moduleForPath(pathname);
    return !key || !modules || modules[key];
}

export function moduleForTool(name: string): ModuleKey | null {
    for (const [key, tools] of Object.entries(MODULE_TOOLS)) if (tools?.includes(name)) return key as ModuleKey;
    return null;
}

/** What a guarded route or tool answers while the module is off. */
export function moduleOffMessage(key: ModuleKey): string {
    return `The ${moduleDefinition(key).label} module is off for this company. An owner or admin can turn it on in Settings → Modules.`;
}
