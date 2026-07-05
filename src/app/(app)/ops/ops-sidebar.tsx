"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
    LayoutDashboard,
    Users,
    Building2,
    AlertTriangle,
    Radio,
    Store,
    PanelLeftClose,
    PanelLeft,
    ChevronDown,
    Shield,
    LogOut,
    Settings,
} from "lucide-react";

type NavItem = {
    href: string;
    label: string;
    icon: React.ElementType;
    section: string;
};

const NAV_ITEMS: NavItem[] = [
    { href: "/ops", label: "Overview", icon: LayoutDashboard, section: "Platform" },
    { href: "/ops/users", label: "Users", icon: Users, section: "Platform" },
    { href: "/ops/companies", label: "Companies", icon: Building2, section: "Platform" },
    { href: "/ops/errors", label: "Errors", icon: AlertTriangle, section: "Data" },
    { href: "/ops/runtimes", label: "Runtimes", icon: Radio, section: "Data" },
    { href: "/ops/resellers", label: "Resellers", icon: Store, section: "Commerce" },
];

const SECTIONS = ["Platform", "Data", "Commerce"] as const;

const SECTION_ICONS: Record<string, React.ElementType> = {
    Platform: Shield,
    Data: ChevronDown,
    Commerce: Store,
};

export function OpsSidebar({ onNavigate }: { onNavigate?: () => void }) {
    const pathname = usePathname();
    const [collapsed, setCollapsed] = useState(false);
    const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(SECTIONS));

    const toggleSection = useCallback((section: string) => {
        setExpandedSections((prev) => {
            const next = new Set(prev);
            if (next.has(section)) next.delete(section);
            else next.add(section);
            return next;
        });
    }, []);

    const handleNav = useCallback(() => {
        onNavigate?.();
    }, [onNavigate]);

    return (
        <aside
            className={cn(
                "fixed left-0 top-0 z-40 flex h-full flex-col border-r border-zinc-800/60 bg-zinc-950 transition-all duration-300",
                collapsed ? "w-16" : "w-60"
            )}
        >
            {/* Brand area */}
            <div className={cn(
                "flex shrink-0 items-center gap-3 border-b border-zinc-800/60 bg-gradient-to-r from-indigo-950/80 to-zinc-950 px-4",
                collapsed ? "justify-center py-4" : "py-3"
            )}>
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 shadow-lg shadow-indigo-600/20">
                    <Shield className="h-4 w-4 text-white" />
                </div>
                {!collapsed && (
                    <div className="min-w-0">
                        <div className="text-sm font-semibold text-zinc-100">InvoiceAI</div>
                        <div className="text-[10px] uppercase tracking-widest text-indigo-400">Platform Ops</div>
                    </div>
                )}
            </div>

            {/* Navigation */}
            <nav className="flex-1 overflow-y-auto px-2 py-4 scrollbar-thin scrollbar-track-zinc-900 scrollbar-thumb-zinc-700">
                {SECTIONS.map((section) => {
                    const items = NAV_ITEMS.filter((item) => item.section === section);
                    if (items.length === 0) return null;
                    const isExpanded = expandedSections.has(section);
                    const SectionIcon = SECTION_ICONS[section];

                    return (
                        <div key={section} className="mb-4">
                            {!collapsed && (
                                <button
                                    onClick={() => toggleSection(section)}
                                    className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500 hover:text-zinc-300 transition-colors"
                                >
                                    <ChevronDown
                                        className={cn(
                                            "h-3 w-3 transition-transform",
                                            isExpanded ? "rotate-0" : "-rotate-90"
                                        )}
                                    />
                                    {section}
                                </button>
                            )}
                            <div className={cn("space-y-0.5", !isExpanded && !collapsed && "hidden")}>
                                {items.map((item) => {
                                    const isActive = pathname === item.href;
                                    const Icon = item.icon;
                                    return (
                                        <Link
                                            key={item.href}
                                            href={item.href}
                                            onClick={handleNav}
                                            className={cn(
                                                "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150",
                                                collapsed && "justify-center px-0",
                                                isActive
                                                    ? "bg-indigo-500/10 text-indigo-300 shadow-sm shadow-indigo-500/5"
                                                    : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
                                            )}
                                        >
                                            <Icon className={cn(
                                                "h-4 w-4 shrink-0 transition-colors",
                                                isActive ? "text-indigo-400" : "text-zinc-500 group-hover:text-zinc-300"
                                            )} />
                                            {!collapsed && <span>{item.label}</span>}
                                        </Link>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </nav>

            {/* Bottom: user profile / collapse toggle */}
            <div className="shrink-0 border-t border-zinc-800/60 p-3">
                {!collapsed ? (
                    <div className="flex items-center gap-3 rounded-lg px-2 py-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600/20 text-xs font-medium text-indigo-400 ring-1 ring-indigo-500/20">
                            AD
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium text-zinc-300">Admin</div>
                            <div className="truncate text-[10px] text-zinc-500">Platform Administrator</div>
                        </div>
                        <button
                            onClick={() => setCollapsed(true)}
                            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
                        >
                            <PanelLeftClose className="h-4 w-4" />
                        </button>
                    </div>
                ) : (
                    <div className="flex flex-col items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600/20 text-xs font-medium text-indigo-400 ring-1 ring-indigo-500/20">
                            AD
                        </div>
                        <button
                            onClick={() => setCollapsed(true)}
                            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
                        >
                            <PanelLeftClose className="h-4 w-4" />
                        </button>
                    </div>
                )}
            </div>

            {/* Collapse toggle when already collapsed */}
            {collapsed && (
                <div className="shrink-0 border-t border-zinc-800/60 p-2">
                    <button
                        onClick={() => setCollapsed(false)}
                        className="flex w-full items-center justify-center rounded-md p-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
                        title="Expand sidebar"
                    >
                        <PanelLeft className="h-4 w-4" />
                    </button>
                </div>
            )}
        </aside>
    );
}

/** Top header bar with breadcrumb */
export function OpsHeader({ breadcrumb }: { breadcrumb: string }) {
    return (
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-zinc-800/60 bg-zinc-950/80 px-6 backdrop-blur-lg">
            <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                    <span className="text-zinc-600">Ops</span>
                    <span className="text-zinc-700">/</span>
                    <span className="font-medium text-zinc-200">{breadcrumb}</span>
                </div>
            </div>
            <div className="flex items-center gap-3">
                <div className="flex h-7 items-center rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 text-xs text-zinc-500">
                    <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    Live
                </div>
            </div>
        </header>
    );
}
