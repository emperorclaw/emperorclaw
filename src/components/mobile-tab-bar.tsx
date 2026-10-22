"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconFolder, IconLayoutDashboard, IconMessage, IconRobot, IconRosetteDiscountCheck } from "@tabler/icons-react";
import { useNavBadges } from "@/components/use-nav-badges";
import { cn } from "@/lib/utils";

/**
 * Phone navigation: the five places people come back to all day, in thumb
 * reach. Everything else stays in the header menu. Rendered as the last row of
 * the app shell's column (not fixed), so it never covers a chat composer.
 */
export function MobileTabBar() {
    const pathname = usePathname();
    const { unreadMessages, pendingApprovals } = useNavBadges();

    const tabs = [
        { name: "Home", href: "/", icon: IconLayoutDashboard, badge: 0 },
        { name: "Messages", href: "/messages", icon: IconMessage, badge: unreadMessages },
        { name: "Projects", href: "/projects", icon: IconFolder, badge: 0 },
        { name: "Approvals", href: "/approvals", icon: IconRosetteDiscountCheck, badge: pendingApprovals },
        { name: "Agents", href: "/agents", icon: IconRobot, badge: 0, activeFor: ["/budgets"] },
    ];
    const matches = (href: string) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));

    return (
        <nav
            aria-label="Primary"
            className="grid shrink-0 grid-cols-5 border-t border-border bg-sidebar/95 backdrop-blur-xl md:hidden"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
            {tabs.map((tab) => {
                const active = matches(tab.href) || (tab.activeFor ?? []).some(matches);
                const Icon = tab.icon;
                return (
                    <Link
                        key={tab.href}
                        href={tab.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                            "relative flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors",
                            active ? "text-primary" : "text-muted-foreground active:text-foreground",
                        )}
                    >
                        {active && <span className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-primary" aria-hidden />}
                        <span className="relative">
                            <Icon className="h-5 w-5" />
                            {tab.badge > 0 && (
                                <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-rose-500 px-1 text-center text-[10px] font-bold leading-4 text-white">
                                    {tab.badge > 99 ? "99+" : tab.badge}
                                </span>
                            )}
                        </span>
                        {tab.name}
                    </Link>
                );
            })}
        </nav>
    );
}
