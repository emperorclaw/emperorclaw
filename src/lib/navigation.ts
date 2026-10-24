/**
 * The app's information architecture (docs/roadmap/product-decisions.md,
 * section 3), shared by the desktop sidebar, the phone menu, the bottom tabs
 * and the command palette. One shell, no feature flags: an item exists only
 * when its page exists (tests/unit/navigation.test.ts checks every href).
 */

export type NavBadgeKey = "live" | "inbox" | "messages";

export interface NavItem {
    id: string;
    name: string;
    href: string;
    /** Other routes that light this item up. */
    activeFor?: string[];
    badge?: NavBadgeKey;
    /** Extra words the command palette matches. */
    keywords?: string;
}

export interface NavSection {
    /** Empty for the unlabeled attention cluster and the Settings row. */
    title: string;
    id: string;
    items: NavItem[];
    collapsible?: boolean;
    /** Collapsed until the person opens it. */
    defaultCollapsed?: boolean;
}

export interface NavAccess {
    isCompanyAdmin: boolean;
    isPlatformAdmin: boolean;
}

/** Where collapsed sections are remembered (per browser). */
export const NAV_SECTIONS_STORAGE_KEY = "emperor-sidebar-sections";

export function navSections({ isCompanyAdmin, isPlatformAdmin }: NavAccess): NavSection[] {
    const admin: NavItem[] = [
        ...(isCompanyAdmin ? [{ id: "costs", name: "Costs", href: "/budgets", keywords: "budgets spend money tokens" }] : []),
        ...(isPlatformAdmin ? [{ id: "ops", name: "Operations", href: "/ops", keywords: "platform runtimes companies users storage errors" }] : []),
    ];
    const sections: NavSection[] = [
        {
            title: "", id: "attention", items: [
                { id: "home", name: "Home", href: "/", badge: "live", keywords: "dashboard office team" },
                { id: "inbox", name: "Inbox", href: "/inbox", badge: "inbox", activeFor: ["/approvals"], keywords: "needs me approvals decisions blocked" },
                { id: "messages", name: "Messages", href: "/messages", badge: "messages", keywords: "chat threads" },
            ],
        },
        {
            title: "Work", id: "work", collapsible: true, items: [
                { id: "projects", name: "Projects", href: "/projects", keywords: "tasks board" },
                { id: "timeline", name: "Timeline", href: "/timeline", keywords: "gantt chart work history handoffs" },
                { id: "automations", name: "Automations", href: "/pipelines", keywords: "pipelines schedules recurring" },
                { id: "files", name: "Files", href: "/artifacts", keywords: "artifacts documents storage" },
            ],
        },
        {
            title: "Clients & knowledge", id: "clients", collapsible: true, items: [
                { id: "customers", name: "Customers", href: "/customers", keywords: "clients accounts" },
                { id: "knowledge", name: "Knowledge base", href: "/resources", keywords: "brain doctrine notes resources" },
            ],
        },
        {
            title: "Team", id: "team", collapsible: true, items: [
                // Costs is an Admin row for admins; everyone else reaches it from Agents.
                { id: "agents", name: "Agents", href: "/agents", activeFor: isCompanyAdmin ? [] : ["/budgets"], keywords: "hire workers bots" },
                { id: "org", name: "Org chart", href: "/agents/organization", keywords: "organization structure reports" },
                ...(isCompanyAdmin ? [{ id: "people", name: "People", href: "/settings/members", keywords: "members invite users roles" }] : []),
            ],
        },
        ...(admin.length ? [{ title: "Admin", id: "admin", collapsible: true, defaultCollapsed: true, items: admin }] : []),
        {
            title: "", id: "system", items: [
                { id: "settings", name: "Settings", href: "/settings", keywords: "workspace preferences tokens notifications" },
            ],
        },
    ];
    return sections;
}

/** Phone bottom tabs: five, fixed order, never flag-dependent. */
export const MOBILE_TABS: NavItem[] = [
    { id: "home", name: "Home", href: "/", badge: "live" },
    { id: "inbox", name: "Inbox", href: "/inbox", badge: "inbox", activeFor: ["/approvals"] },
    { id: "messages", name: "Messages", href: "/messages", badge: "messages" },
    { id: "projects", name: "Projects", href: "/projects" },
    { id: "agents", name: "Agents", href: "/agents", activeFor: ["/budgets"] },
];

export function pathMatches(pathname: string, href: string): boolean {
    return pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
}

/** One active item: the most specific href that matches (Org chart over Agents, People over Settings). */
export function activeNavHref(pathname: string, items: readonly NavItem[]): string | null {
    let best: { href: string; score: number } | null = null;
    for (const item of items) {
        const own = pathMatches(pathname, item.href) ? item.href.length : -1;
        const alias = Math.max(-1, ...(item.activeFor ?? []).filter((href) => pathMatches(pathname, href)).map((href) => href.length));
        const score = Math.max(own, alias);
        if (score >= 0 && (!best || score > best.score)) best = { href: item.href, score };
    }
    return best?.href ?? null;
}

/** Parse the stored collapsed-sections map, tolerating anything malformed. */
export function readCollapsedSections(raw: string | null): Record<string, boolean> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "boolean")) as Record<string, boolean>;
    } catch {
        return {};
    }
}
