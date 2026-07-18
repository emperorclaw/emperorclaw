"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { createPortal } from "react-dom";
import { LayoutDashboard, FolderKanban, Bot, ShieldCheck, KeyRound, Terminal, LogOut, User, HardDrive, MessageSquare, BadgeCheck, BookOpen, ScrollText, GitBranch, PanelLeftClose, PanelLeftOpen } from "lucide-react";
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

export function AppSidebar({ isPlatformAdmin = false }: { isPlatformAdmin?: boolean }) {
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
        { name: "Dashboard", href: "/", icon: LayoutDashboard },
        { name: "Projects", href: "/projects", icon: FolderKanban },
        { name: "Automations", href: "/pipelines", icon: GitBranch },
        { name: "Knowledge base", href: "/resources", icon: ScrollText },
        { name: "Messages", href: "/messages", icon: MessageSquare },
        { name: "Approvals", href: "/approvals", icon: BadgeCheck },
        { name: "Agents", href: "/agents", icon: Bot },
        { name: "Customers", href: "/customers", icon: ShieldCheck },
        { name: "Files", href: "/artifacts", icon: HardDrive },
        { name: "Settings", href: "/settings", icon: KeyRound },
    ];

    if (isPlatformAdmin) {
        links.push({ name: "Ops", href: "/ops", icon: Terminal });
    }

    return (
        <>
        <aside className={cn("flex h-full shrink-0 flex-col border-r border-white/10 bg-zinc-950/72 shadow-2xl shadow-black/30 backdrop-blur-2xl transition-[width] duration-300 ease-in-out overflow-hidden", collapsed ? "w-20" : "w-20 md:w-64")}>
            <div className={cn("border-b border-white/10", collapsed ? "p-3" : "p-3.5 sm:p-5")}>
                <div className={cn(
                    "flex items-center",
                    collapsed
                        ? "justify-center"
                        : "gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-2.5 sm:p-3"
                )}>
                    {collapsed ? (
                        /* Collapsed: show only the emblem, centered */
                        <div className="grid h-10 w-10 shrink-0 place-items-center">
                            <CustomLogo className="h-10 w-10" />
                        </div>
                    ) : (
                        /* Expanded: show only the text */
                        <div className={cn("min-w-0 flex-1 transition-opacity duration-200", collapsed ? "opacity-0" : "hidden md:block")}>
                            <div className="truncate text-base font-semibold tracking-tight text-white">Emperor Claw</div>
                        </div>
                    )}
                </div>
            </div>

            <nav className="flex-1 space-y-0.5 sm:space-y-1 overflow-y-auto overflow-x-visible px-2 py-4 sm:px-4 sm:py-5">
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
                                    ? "border border-cyan-400/20 bg-cyan-400/10 text-white shadow-sm shadow-cyan-950/20"
                                    : "text-zinc-400 hover:bg-white/[0.045] hover:text-zinc-100"
                            )}
                        >
                            <span className="relative shrink-0">
                                <Icon className={cn("h-4 w-4", isActive ? "text-cyan-300" : "text-zinc-500 group-hover:text-zinc-300")} />
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

            <div className={cn("border-t border-white/10", collapsed ? "space-y-2 p-2" : "space-y-2 sm:space-y-3 p-3 sm:p-4")}>
                    {/* Collapse / Expand toggle */}
                    <button
                        type="button"
                        onClick={toggleCollapsed}
                        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                        className={cn(
                            "flex w-full cursor-pointer items-center rounded-xl text-sm font-medium text-zinc-400 transition-all duration-200 hover:bg-white/[0.045] hover:text-zinc-100",
                            collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2.5"
                        )}
                    >
                        {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
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
                                ? "border border-cyan-400/20 bg-cyan-400/10 text-white"
                                : "text-zinc-400 hover:bg-white/[0.045] hover:text-zinc-100"
                        )}
                    >
                        <BookOpen className={cn("h-4 w-4", pathname?.startsWith("/docs") ? "text-cyan-300" : "text-zinc-500")} />
                        <span className={cn("transition-opacity duration-200", collapsed ? "hidden" : "md:inline")}>Documentation</span>
                    </Link>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button className={cn(
                                "group relative flex w-full cursor-pointer items-center rounded-2xl border border-white/10 bg-white/[0.035] text-left transition-colors hover:border-white/15 hover:bg-white/[0.055]",
                                collapsed ? "justify-center px-2 py-2.5" : "gap-2.5 sm:gap-3 px-2.5 py-2.5 sm:px-3 sm:py-3"
                            )}
                                title={collapsed ? `${userName}\n${userEmail}` : undefined}
                            >
                                <div className="grid h-8 w-8 sm:h-9 sm:w-9 shrink-0 place-items-center rounded-full border border-zinc-700 bg-zinc-900 text-xs font-bold text-zinc-200">
                                    {userInitial}
                                </div>
                                <div className={cn("min-w-0 flex-1 flex-col transition-opacity duration-200", collapsed ? "hidden" : "md:flex")}>
                                    <span className="truncate text-sm font-medium text-zinc-100">{userName}</span>
                                    <span className="text-xs text-zinc-500">{userEmail}</span>
                                </div>
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-56 border-zinc-800 bg-zinc-950 text-zinc-200 shadow-2xl shadow-black/40">
                            <DropdownMenuItem asChild className="gap-2 text-zinc-200 focus:bg-zinc-900">
                                <Link href="/settings">
                                    <User className="h-4 w-4 text-zinc-400" />
                                    <span>Workspace Settings</span>
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                className="gap-2 text-zinc-200 focus:bg-zinc-900"
                                onClick={() => signOut({ callbackUrl: "/login" })}
                            >
                                <LogOut className="h-4 w-4 text-zinc-400" />
                                <span>Logout</span>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
        </aside>
        {hoveredNav && tooltipPos && typeof document !== "undefined" && createPortal(
            <div
                className="pointer-events-none fixed whitespace-nowrap rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-100 shadow-lg ring-1 ring-white/10 z-[9999]"
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
