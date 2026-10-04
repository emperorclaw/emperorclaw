"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { createPortal } from "react-dom";
import { IconLayoutDashboard, IconFolder, IconRobot, IconShieldCheck, IconKey, IconLogout, IconUser, IconDeviceSdCard, IconMessage, IconRosetteDiscountCheck, IconBook, IconFileText, IconGitBranch, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconUsers } from "@tabler/icons-react";
import { ThemeToggle } from "./theme-toggle";
import { NotificationBell } from "./notification-bell";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { CustomLogo } from "./custom-logo";
import { signOut } from "next-auth/react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

const SIDEBAR_COLLAPSE_KEY = "emperor-sidebar-collapsed";

const UTILITY_BUTTON = "flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

export function AppSidebar({ isPlatformAdmin = false, isCompanyAdmin = false, appVersion }: { isPlatformAdmin?: boolean; isCompanyAdmin?: boolean; appVersion?: string }) {
    const pathname = usePathname();
    const { data: session } = useSession();
    const [collapsed, setCollapsed] = useState(false);
    const [unreadMessages, setUnreadMessages] = useState(0);
    const [pendingApprovals, setPendingApprovals] = useState(0);
    const [hoveredNav, setHoveredNav] = useState<string | null>(null);
    const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);

    useEffect(() => {
        // Deliberately deferred to an effect: localStorage isn't available
        // during SSR, so reading it in the initial render would mismatch
        // between server and client hydration output.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1") setCollapsed(true);
    }, []);

    useEffect(() => {
        let cancelled = false;
        const poll = async () => {
            try {
                const [res, approvalsRes] = await Promise.all([fetch("/api/chat/unread-count"), fetch("/api/approvals/pending-count")]);
                if (cancelled) return;
                if (res.ok) setUnreadMessages((await res.json()).count || 0);
                if (approvalsRes.ok) setPendingApprovals((await approvalsRes.json()).count || 0);
            } catch {
                // Non-critical — badge just stays at its last known value.
            }
        };
        void poll();
        const interval = setInterval(poll, 20000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [pathname]);

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

    // Grouped by what you come to do: the work itself, who does it (agents and
    // people), and what the company knows and owns (customers, knowledge,
    // files, automations). Budgets lives with Agents and Ops with Settings.
    const sections: { title: string; links: { name: string; href: string; icon: typeof IconFolder; badge?: number; activeFor?: string[] }[] }[] = [
        { title: "Work", links: [
            { name: "Dashboard", href: "/", icon: IconLayoutDashboard },
            { name: "Messages", href: "/messages", icon: IconMessage, badge: unreadMessages },
            { name: "Projects", href: "/projects", icon: IconFolder },
            { name: "Approvals", href: "/approvals", icon: IconRosetteDiscountCheck, badge: pendingApprovals },
        ] },
        { title: "Team", links: [
            { name: "Agents", href: "/agents", icon: IconRobot, activeFor: ["/budgets"] },
            // Managing members is an admin page; others would be sent away.
            ...(isCompanyAdmin ? [{ name: "People", href: "/settings/members", icon: IconUsers }] : []),
        ] },
        { title: "Company", links: [
            { name: "Customers", href: "/customers", icon: IconShieldCheck },
            { name: "Knowledge base", href: "/resources", icon: IconFileText },
            { name: "Files", href: "/artifacts", icon: IconDeviceSdCard },
            { name: "Automations", href: "/pipelines", icon: IconGitBranch },
        ] },
        { title: "", links: [
            { name: "Settings", href: "/settings", icon: IconKey, activeFor: isPlatformAdmin ? ["/ops"] : [] },
        ] },
    ];

    // One active item: the most specific link that matches (People over Settings).
    const matches = (href: string) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
    const activeHref = sections.flatMap((section) => section.links)
        .filter((link) => matches(link.href) || (link.activeFor ?? []).some(matches))
        .sort((a, b) => (matches(b.href) ? b.href.length : 0) - (matches(a.href) ? a.href.length : 0))[0]?.href ?? null;

    return (
        <>
        <aside className={cn("flex h-full w-16 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar shadow-2xl shadow-black/10 backdrop-blur-2xl transition-[width] duration-300 ease-in-out sm:w-20", collapsed ? "md:w-20" : "md:w-64")}>
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

            <nav className="flex-1 space-y-0.5 overflow-y-auto overflow-x-visible px-1.5 py-2 sm:px-3 sm:py-3">
                {sections.map((section) => (
                <div key={section.title || "system"} className="pb-1.5">
                    {section.title && !collapsed && <div className="hidden px-2.5 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/85 md:block">{section.title}</div>}
                    {collapsed && section.title && <div className="mx-auto my-1.5 h-px w-6 bg-border" aria-hidden />}
                {section.links.map((link) => {
                    const Icon = link.icon;
                    const isActive = activeHref === link.href;
                    const badge = link.badge ?? 0;
                    const showUnread = badge > 0;
                    return (
                        <Link
                            key={link.name}
                            href={link.href}
                            onMouseEnter={(e) => {
                                if (!collapsed) return;
                                const rect = e.currentTarget.getBoundingClientRect();
                                setTooltipPos({ top: rect.top + rect.height / 2, left: rect.right + 12 });
                                setHoveredNav(link.name);
                            }}
                            onMouseLeave={() => { setHoveredNav(null); setTooltipPos(null); }}
                            className={cn(
                                "relative flex items-center rounded-xl px-2.5 py-2 text-sm font-medium transition-all duration-200",
                                collapsed ? "justify-center gap-0" : "gap-3",
                                isActive
                                    ? "border border-primary/20 bg-primary/10 text-foreground shadow-sm"
                                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                            )}
                        >
                            <span className="relative shrink-0">
                                <Icon className={cn("h-4 w-4", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                                {showUnread && collapsed && (
                                    <span className="absolute -right-1.5 -top-1.5 h-2 w-2 rounded-full bg-rose-500" />
                                )}
                            </span>
                            <span className={cn("hidden min-w-0 flex-1 truncate", collapsed ? "" : "md:inline")}>{link.name}</span>
                            {showUnread && !collapsed && (
                                <span className="hidden shrink-0 rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white md:inline-block">
                                    {badge > 99 ? "99+" : badge}
                                </span>
                            )}
                        </Link>
                    );
                })}
                </div>
                ))}
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
