"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { createPortal } from "react-dom";
import {
    IconBook, IconBuildingStore, IconChevronDown, IconCoin, IconDeviceSdCard, IconFileText, IconFolder, IconGitBranch, IconHierarchy2, IconHome, IconInbox, IconKey,
    IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconLogout, IconMenu2, IconMessage, IconPlus, IconRobot, IconSearch, IconServerCog, IconUser, IconUsers,
} from "@tabler/icons-react";
import { ThemeToggle } from "./theme-toggle";
import { NotificationBell } from "./notification-bell";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { CustomLogo } from "./custom-logo";
import { useNavBadges } from "./use-nav-badges";
import { openCommandPalette } from "./command-palette";
import { signOut } from "next-auth/react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger, DialogClose } from "@/components/ui/dialog";
import { activeNavHref, NAV_SECTIONS_STORAGE_KEY, navSections, readCollapsedSections, type NavBadgeKey, type NavItem } from "@/lib/navigation";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

const SIDEBAR_COLLAPSE_KEY = "emperor-sidebar-collapsed";

const UTILITY_BUTTON = "flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

const NAV_ICONS: Record<string, typeof IconFolder> = {
    home: IconHome,
    inbox: IconInbox,
    messages: IconMessage,
    projects: IconFolder,
    automations: IconGitBranch,
    files: IconDeviceSdCard,
    customers: IconBuildingStore,
    knowledge: IconFileText,
    agents: IconRobot,
    org: IconHierarchy2,
    people: IconUsers,
    costs: IconCoin,
    ops: IconServerCog,
    settings: IconKey,
};

type Badges = ReturnType<typeof useNavBadges>;

/** The badge one nav item shows: live work in cyan, inbox amber (red when something failed), unread messages. */
function badgeFor(key: NavBadgeKey | undefined, badges: Badges): { text: string; tone: "live" | "warn" | "fail" | "unread"; label: string } | null {
    const cap = (n: number) => (n > 99 ? "99+" : String(n));
    if (key === "live" && badges.workingNow > 0) return { text: `${badges.workingNow} working`, tone: "live", label: `${badges.workingNow} agents working now` };
    if (key === "inbox" && badges.inbox > 0) return { text: cap(badges.inbox), tone: badges.inboxHasFailures ? "fail" : "warn", label: `${badges.inbox} unread ${badges.inbox === 1 ? "item needs" : "items need"} you${badges.inboxHasFailures ? ", some failed" : ""}` };
    if (key === "messages" && badges.unreadMessages > 0) return { text: cap(badges.unreadMessages), tone: "unread", label: `${badges.unreadMessages} unread messages` };
    return null;
}

const BADGE_TONE = {
    live: "bg-cyan-400/10 text-cyan-700 ring-1 ring-inset ring-cyan-400/30 dark:text-cyan-200",
    warn: "bg-amber-400/15 text-amber-700 ring-1 ring-inset ring-amber-400/35 dark:text-amber-200",
    fail: "bg-rose-500 text-white",
    unread: "bg-primary/15 text-primary ring-1 ring-inset ring-primary/30",
} as const;

const DOT_TONE = { live: "bg-cyan-400", warn: "bg-amber-400", fail: "bg-rose-500", unread: "bg-primary" } as const;

function NavBadge({ badge }: { badge: NonNullable<ReturnType<typeof badgeFor>> }) {
    return (
        <span aria-label={badge.label} className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none tabular-nums", BADGE_TONE[badge.tone])}>
            {badge.tone === "live" && (
                <span aria-hidden className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60 motion-reduce:animate-none" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-400" />
                </span>
            )}
            {badge.text}
        </span>
    );
}

export function AppSidebar({ isPlatformAdmin = false, isCompanyAdmin = false, canAct = true, appVersion }: { isPlatformAdmin?: boolean; isCompanyAdmin?: boolean; canAct?: boolean; appVersion?: string }) {
    const pathname = usePathname();
    const { data: session } = useSession();
    const [collapsed, setCollapsed] = useState(false);
    const [folded, setFolded] = useState<Record<string, boolean>>({});
    const [modKey, setModKey] = useState("Ctrl");
    const badges = useNavBadges();
    const [hoveredNav, setHoveredNav] = useState<string | null>(null);
    const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);

    useEffect(() => {
        // Deliberately deferred to an effect: localStorage isn't available
        // during SSR, so reading it in the initial render would mismatch
        // between server and client hydration output.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1") setCollapsed(true);
        setFolded(readCollapsedSections(localStorage.getItem(NAV_SECTIONS_STORAGE_KEY)));
        if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setModKey("⌘");
    }, []);

    function toggleCollapsed() {
        setCollapsed((current) => {
            const next = !current;
            localStorage.setItem(SIDEBAR_COLLAPSE_KEY, next ? "1" : "0");
            return next;
        });
    }

    // Persist last known user identity across SPA navigations to prevent
    // the sidebar flashing "U User" while the session rehydrates.
    const lastUserRef = useRef<{ email: string; name: string }>({ email: "", name: "" });
    if (session?.user?.email) {
        lastUserRef.current = { email: session.user.email, name: session.user.name || "" };
    }
    const userEmail = session?.user?.email || lastUserRef.current.email || "";
    const userName = session?.user?.name || lastUserRef.current.name || userEmail.split("@")[0] || "User";
    const userInitial = (userName[0] || "U").toUpperCase();

    // docs/roadmap/product-decisions.md section 3: the attention cluster
    // first, then Work, Clients & knowledge, Team, a collapsed Admin, Settings.
    const sections = navSections({ isCompanyAdmin, isPlatformAdmin });
    const allItems = sections.flatMap((section) => section.items);
    const activeHref = activeNavHref(pathname, allItems);
    const isFolded = (id: string, defaultCollapsed = false) => {
        // The section holding the current page always shows it.
        const section = sections.find((s) => s.id === id);
        if (section?.items.some((item) => item.href === activeHref)) return false;
        return folded[id] ?? defaultCollapsed;
    };
    const toggleSection = (id: string, defaultCollapsed = false) => {
        setFolded((current) => {
            const next = { ...current, [id]: !(current[id] ?? defaultCollapsed) };
            try { localStorage.setItem(NAV_SECTIONS_STORAGE_KEY, JSON.stringify(next)); } catch { /* private mode: session only */ }
            return next;
        });
    };

    const renderLink = (link: NavItem) => {
        const Icon = NAV_ICONS[link.id] ?? IconFolder;
        const isActive = activeHref === link.href;
        const badge = badgeFor(link.badge, badges);
        return (
            <Link
                key={link.id}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                onMouseEnter={(e) => {
                    if (!collapsed) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTooltipPos({ top: rect.top + rect.height / 2, left: rect.right + 12 });
                    setHoveredNav(badge ? `${link.name} (${badge.text})` : link.name);
                }}
                onMouseLeave={() => { setHoveredNav(null); setTooltipPos(null); }}
                className={cn(
                    "relative flex items-center rounded-xl px-2.5 py-[7px] text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70",
                    collapsed ? "justify-center gap-0" : "gap-3",
                    isActive
                        ? "border border-primary/20 bg-primary/10 text-foreground shadow-sm"
                        : "border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
            >
                <span className="relative shrink-0">
                    <Icon className={cn("h-4 w-4", isActive ? "text-primary" : "text-muted-foreground")} />
                    {badge && collapsed && (
                        <span aria-hidden className={cn("absolute -right-1.5 -top-1.5 h-2 w-2 rounded-full ring-2 ring-sidebar", DOT_TONE[badge.tone])} />
                    )}
                </span>
                <span className={cn("hidden min-w-0 flex-1 truncate", collapsed ? "" : "md:inline")}>{link.name}</span>
                {badge && !collapsed && <span className="hidden md:inline-flex"><NavBadge badge={badge} /></span>}
                {badge && collapsed && <span className="sr-only">{badge.label}</span>}
            </Link>
        );
    };

    return (
        <>
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-sidebar px-4 py-2 md:hidden" style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}>
            <Link href="/" className="flex min-h-11 items-center gap-2 text-sm font-semibold"><CustomLogo className="h-7 w-7" /> Emperor Claw</Link>
            <div className="flex items-center gap-2">
                <button type="button" onClick={openCommandPalette} aria-label="Search and jump" className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-border text-muted-foreground hover:text-foreground"><IconSearch className="h-5 w-5" /></button>
                <Dialog>
                    <DialogTrigger asChild>
                        <button aria-label="Open navigation" className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-border"><IconMenu2 className="h-5 w-5" /></button>
                    </DialogTrigger>
                    <DialogContent className="max-h-[85dvh] overflow-y-auto border-border bg-popover text-foreground dark:bg-zinc-950/95">
                        <DialogTitle className="text-foreground">Navigation</DialogTitle>
                        <DialogDescription className="sr-only">Every page in your workspace.</DialogDescription>
                        <nav aria-label="Mobile navigation" className="space-y-3">
                            {sections.map((section) => <div key={section.id}>
                                {section.title && <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{section.title}</p>}
                                {section.items.map((link) => {
                                    const Icon = NAV_ICONS[link.id] ?? IconFolder;
                                    const badge = badgeFor(link.badge, badges);
                                    return (
                                        <DialogClose asChild key={link.id}>
                                            <Link href={link.href} aria-current={activeHref === link.href ? "page" : undefined} className={cn("flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm", activeHref === link.href ? "bg-primary/10 text-primary" : "text-foreground")}>
                                                <Icon className="h-5 w-5 shrink-0" /><span className="flex-1">{link.name}</span>
                                                {badge && <NavBadge badge={badge} />}
                                            </Link>
                                        </DialogClose>
                                    );
                                })}
                            </div>)}
                        </nav>
                        <div className="flex items-center justify-between border-t border-border pt-3"><ThemeToggle /><button onClick={() => signOut()} className="min-h-11 px-3 text-sm">Sign out</button></div>
                    </DialogContent>
                </Dialog>
            </div>
        </header>
        <aside className={cn("hidden md:flex h-full w-16 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar shadow-2xl shadow-black/10 backdrop-blur-2xl transition-[width] duration-300 ease-in-out sm:w-20", collapsed ? "md:w-20" : "md:w-64")}>
            <div className={cn("flex h-14 shrink-0 items-center border-b border-border", collapsed ? "justify-center px-2" : "px-3 sm:px-5")}>
                {collapsed ? (
                    <CustomLogo className="h-7 w-7" />
                ) : (
                    <>
                        <CustomLogo className="h-7 w-7 md:hidden" />
                        <Link href="/" className="hidden min-w-0 truncate text-[13px] tracking-[0.14em] text-foreground md:block" style={{ fontFamily: "var(--font-silkscreen)" }}>
                            EMPEROR<span className="text-primary">CLAW</span>
                        </Link>
                    </>
                )}
            </div>

            {/* Search opens the command palette; New task is the one primary action. */}
            <div className={cn("flex shrink-0 gap-1.5 px-1.5 pt-3 sm:px-3", collapsed ? "flex-col items-center" : "items-center")}>
                <button
                    type="button"
                    onClick={openCommandPalette}
                    aria-label="Search and jump"
                    aria-keyshortcuts="Control+K Meta+K"
                    title={collapsed ? `Search (${modKey} K)` : undefined}
                    className={cn(
                        "group flex h-9 items-center rounded-xl border border-border bg-muted/40 text-sm text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 dark:bg-white/[0.03]",
                        collapsed ? "w-9 justify-center" : "min-w-0 flex-1 gap-2 px-2.5",
                    )}
                >
                    <IconSearch className="h-4 w-4 shrink-0" />
                    {!collapsed && <span className="flex-1 truncate text-left">Search</span>}
                    {!collapsed && <kbd className="rounded-md border border-border bg-background/60 px-1.5 font-mono text-[10px] leading-5 text-muted-foreground">{modKey} K</kbd>}
                </button>
                {canAct && (
                    <Link
                        href="/projects?new=task"
                        aria-label="New task"
                        title="New task"
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm shadow-primary/20 transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                    >
                        <IconPlus className="h-4 w-4" stroke={2.4} />
                    </Link>
                )}
            </div>

            <nav aria-label="Main" className="flex-1 overflow-y-auto overflow-x-visible px-1.5 py-2 sm:px-3">
                {sections.map((section) => {
                    const sectionFolded = !collapsed && section.collapsible ? isFolded(section.id, section.defaultCollapsed) : false;
                    const listId = `nav-section-${section.id}`;
                    return (
                        <div key={section.id} className={cn(section.id === "attention" ? "pb-2" : "pb-1.5", section.id === "system" && "mt-1 border-t border-border/60 pt-2")}>
                            {section.title && !collapsed && (
                                <button
                                    type="button"
                                    onClick={() => toggleSection(section.id, section.defaultCollapsed)}
                                    aria-expanded={!sectionFolded}
                                    aria-controls={listId}
                                    className="group hidden w-full items-center gap-1 rounded-md px-2.5 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/85 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 md:flex"
                                >
                                    <span className="flex-1 text-left">{section.title}</span>
                                    <IconChevronDown className={cn("h-3 w-3 opacity-0 transition-[transform,opacity] group-hover:opacity-100 group-focus-visible:opacity-100", sectionFolded && "-rotate-90 opacity-100")} />
                                </button>
                            )}
                            {collapsed && section.title && <div className="mx-auto my-1.5 h-px w-6 bg-border" aria-hidden />}
                            {!sectionFolded && <div id={listId} className="space-y-0.5">{section.items.map(renderLink)}</div>}
                        </div>
                    );
                })}
            </nav>

            <div className={cn("space-y-1.5 border-t border-border", collapsed ? "p-1.5" : "p-2 sm:p-3")}>
                    <NotificationBell collapsed={collapsed} />
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button className={cn(
                                "group relative flex w-full cursor-pointer items-center rounded-xl border border-border bg-muted/40 text-left transition-colors hover:border-border hover:bg-accent",
                                collapsed ? "justify-center px-1.5 py-1.5" : "justify-center gap-2.5 px-1.5 py-1.5 md:justify-start md:px-2"
                            )}
                                title={collapsed ? `${userName}\n${userEmail}` : undefined}
                            >
                                <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border bg-muted text-xs font-bold text-foreground">
                                    {userInitial}
                                </div>
                                <div className={cn("min-w-0 flex-1 flex-col transition-opacity duration-200", collapsed ? "hidden" : "hidden md:flex")}>
                                    <span className="truncate text-sm font-medium text-foreground">{userName}</span>
                                    <span className="truncate text-[11px] text-muted-foreground">{userEmail}</span>
                                </div>
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-56 border-border bg-popover text-foreground shadow-2xl shadow-black/20">
                            <DropdownMenuItem asChild className="gap-2 text-foreground focus:bg-accent">
                                <Link href="/settings">
                                    <IconUser className="h-4 w-4 text-muted-foreground" />
                                    <span>Workspace Settings</span>
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                className="gap-2 text-foreground focus:bg-accent"
                                onClick={() => signOut({ callbackUrl: "/login" })}
                            >
                                <IconLogout className="h-4 w-4 text-muted-foreground" />
                                <span>Logout</span>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    {/* Small utilities on one line: docs, theme, collapse. */}
                    <div className={cn("flex items-center gap-1 text-muted-foreground", collapsed ? "flex-col" : "flex-col md:flex-row md:justify-between md:pl-1.5")}>
                        {!collapsed && (
                            <a href="https://emperorclaw.com" target="_blank" rel="noreferrer" className="hidden truncate text-[10px] hover:text-foreground md:block" title="emperorclaw.com">
                                v{appVersion || "0.8.7"}
                            </a>
                        )}
                        <div className={cn("flex items-center gap-0.5", collapsed ? "flex-col" : "flex-col md:flex-row")}>
                            <Link
                                href="/docs"
                                aria-label="Documentation"
                                title="Documentation"
                                className={cn(UTILITY_BUTTON, pathname?.startsWith("/docs") && "bg-primary/10 text-primary")}
                            >
                                <IconBook className="h-3.5 w-3.5" />
                            </Link>
                            <ThemeToggle collapsed={collapsed} mini={true} />
                            <button
                                type="button"
                                onClick={toggleCollapsed}
                                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                                title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                                className={cn(UTILITY_BUTTON, "hidden md:flex")}
                            >
                                {collapsed ? <IconLayoutSidebarLeftExpand className="h-3.5 w-3.5" /> : <IconLayoutSidebarLeftCollapse className="h-3.5 w-3.5" />}
                            </button>
                        </div>
                    </div>
                </div>
        </aside>
        {hoveredNav && tooltipPos && typeof document !== "undefined" && createPortal(
            <div
                className="pointer-events-none fixed whitespace-nowrap rounded-lg bg-popover px-3 py-1.5 text-xs font-medium text-foreground shadow-lg ring-1 ring-border z-[9999]"
                style={{
                    top: tooltipPos.top,
                    left: tooltipPos.left,
                    transform: "translateY(-50%)",
                }}
            >
                {hoveredNav}
            </div>,
            document.body
        )}
    </>
    );
}
