"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { createPortal } from "react-dom";
import { IconLayoutDashboard, IconFolder, IconRobot, IconShieldCheck, IconKey, IconTerminal2, IconLogout, IconUser, IconDeviceSdCard, IconMessage, IconRosetteDiscountCheck, IconBook, IconFileText, IconGitBranch, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconWallet } from "@tabler/icons-react";
import { ThemeToggle } from "./theme-toggle";
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

export function AppSidebar({ isPlatformAdmin = false, appVersion }: { isPlatformAdmin?: boolean; appVersion?: string }) {
    const pathname = usePathname();
    const { data: session } = useSession();
    const [collapsed, setCollapsed] = useState(false);
    const [unreadMessages, setUnreadMessages] = useState(0);
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
                const res = await fetch("/api/chat/unread-count");
                if (!res.ok || cancelled) return;
                const data = await res.json();
                if (!cancelled) setUnreadMessages(data.count || 0);
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

    const links = [
        { name: "Dashboard", href: "/", icon: IconLayoutDashboard },
        { name: "Projects", href: "/projects", icon: IconFolder },
        { name: "Automations", href: "/pipelines", icon: IconGitBranch },
        { name: "Knowledge base", href: "/resources", icon: IconFileText },
        { name: "Messages", href: "/messages", icon: IconMessage },
        { name: "Approvals", href: "/approvals", icon: IconRosetteDiscountCheck },
        { name: "Agents", href: "/agents", icon: IconRobot },
        { name: "Customers", href: "/customers", icon: IconShieldCheck },
        { name: "Files", href: "/artifacts", icon: IconDeviceSdCard },
        { name: "Budgets", href: "/budgets", icon: IconWallet },
        { name: "Settings", href: "/settings", icon: IconKey },
    ];

    if (isPlatformAdmin) {
        links.push({ name: "Ops", href: "/ops", icon: IconTerminal2 });
    }

    return (
        <>
        <aside className={cn("flex h-full w-16 shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar shadow-2xl shadow-black/10 backdrop-blur-2xl transition-[width] duration-300 ease-in-out sm:w-20", collapsed ? "md:w-20" : "md:w-64")}>
            <div className={cn("border-b border-border", collapsed ? "p-3" : "p-3.5 sm:p-5")}>
                <div className={cn(
                    "flex items-center",
                    collapsed
                        ? "justify-center"
                        : "gap-3 rounded-2xl border border-border bg-muted/40 p-2.5 sm:p-3"
                )}>
                    {collapsed ? (
                        /* Collapsed: show only the emblem, centered */
                        <div className="grid h-9 w-9 shrink-0 place-items-center sm:h-10 sm:w-10">
                            <CustomLogo className="h-9 w-9 sm:h-10 sm:w-10" />
                        </div>
                    ) : (
                        /* Expanded: show only the text */
                        <div className={cn("min-w-0 flex-1 transition-opacity duration-200", collapsed ? "opacity-0" : "hidden md:block")}>
                            <div className="truncate text-base tracking-[0.15em] text-foreground" style={{ fontFamily: "var(--font-silkscreen)" }}>EMPEROR<span className="text-primary">CLAW</span></div>
                        </div>
                    )}
                </div>
            </div>

            <nav className="flex-1 space-y-0.5 overflow-y-auto overflow-x-visible px-1.5 py-3 sm:space-y-1 sm:px-4 sm:py-5">
                {links.map((link) => {
                    const Icon = link.icon;
                    const isActive = pathname === link.href || (link.href !== "/" && pathname.startsWith(`${link.href}/`));
                    const showUnread = link.name === "Messages" && unreadMessages > 0;
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
                                "relative flex items-center rounded-xl px-2.5 py-2.5 text-sm font-medium transition-all duration-200",
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
                                    {unreadMessages > 99 ? "99+" : unreadMessages}
                                </span>
                            )}
                        </Link>
                    );
                })}
            </nav>

            <div className={cn("border-t border-border", collapsed ? "space-y-2 p-2" : "space-y-2 sm:space-y-3 p-3 sm:p-4")}>
                    {/* Collapse / Expand toggle */}
                    <button
                        type="button"
                        onClick={toggleCollapsed}
                        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                        className={cn(
                            "flex w-full cursor-pointer items-center rounded-xl text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground",
                            collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2.5"
                        )}
                    >
                        {collapsed ? <IconLayoutSidebarLeftExpand className="h-4 w-4" /> : <IconLayoutSidebarLeftCollapse className="h-4 w-4" />}
                        <span className={cn("transition-opacity duration-200", collapsed ? "hidden" : "md:inline")}>{collapsed ? "" : "Collapse"}</span>
                    </button>
                    <Link
                        href="/docs"
                        onMouseEnter={(e) => {
                            if (!collapsed) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            setTooltipPos({ top: rect.top + rect.height / 2, left: rect.right + 12 });
                            setHoveredNav("Documentation");
                        }}
                        onMouseLeave={() => { setHoveredNav(null); setTooltipPos(null); }}
                        className={cn(
                            "relative flex items-center rounded-xl text-sm font-medium transition-all duration-200",
                            collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2.5",
                            pathname?.startsWith("/docs")
                                ? "border border-cyan-400/20 bg-cyan-400/10 text-foreground"
                                : "text-muted-foreground hover:bg-accent hover:text-foreground"
                        )}
                    >
                        <IconBook className={cn("h-4 w-4", pathname?.startsWith("/docs") ? "text-cyan-300" : "text-muted-foreground")} />
                        <span className={cn("transition-opacity duration-200", collapsed ? "hidden" : "md:inline")}>Documentation</span>
                    </Link>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button className={cn(
                                "group relative flex w-full cursor-pointer items-center rounded-2xl border border-border bg-muted/40 text-left transition-colors hover:border-border hover:bg-accent",
                                collapsed ? "justify-center px-2 py-2.5" : "gap-2.5 sm:gap-3 px-2.5 py-2.5 sm:px-3 sm:py-3"
                            )}
                                title={collapsed ? `${userName}\n${userEmail}` : undefined}
                            >
                                <div className="grid h-8 w-8 sm:h-9 sm:w-9 shrink-0 place-items-center rounded-full border border-border bg-muted text-xs font-bold text-foreground">
                                    {userInitial}
                                </div>
                                <div className={cn("min-w-0 flex-1 flex-col transition-opacity duration-200", collapsed ? "hidden" : "md:flex")}>
                                    <span className="truncate text-sm font-medium text-foreground">{userName}</span>
                                    <span className="text-xs text-muted-foreground">{userEmail}</span>
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
                    <div className={cn("flex items-center justify-between gap-2 px-1 text-[10px] text-muted-foreground", collapsed ? "justify-center" : "")}>
                        {!collapsed && (
                            <span className="truncate transition-opacity duration-200">
                                v{appVersion || "0.8.7"} · emperorclaw.com
                            </span>
                        )}
                        <ThemeToggle collapsed={collapsed} mini={true} />
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
