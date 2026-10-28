"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconFolder, IconHome, IconInbox, IconMessage, IconRobot } from "@tabler/icons-react";
import { useNavBadges } from "@/components/use-nav-badges";
import { activeNavHref, mobileTabs } from "@/lib/navigation";
import type { ModuleState } from "@/lib/modules";
import { cn } from "@/lib/utils";

const TAB_ICONS: Record<string, typeof IconHome> = {
    home: IconHome,
    inbox: IconInbox,
    messages: IconMessage,
    projects: IconFolder,
    agents: IconRobot,
};

/**
 * Phone navigation: Home, Inbox, Messages, Projects, Agents (fixed order,
 * docs/roadmap/product-decisions.md section 3). Everything else stays in the
 * header menu. Rendered as the last row of the app shell's column (not
 * fixed), so it never covers a chat composer.
 */
export function MobileTabBar({ modules }: { modules?: ModuleState | null }) {
    const pathname = usePathname();
    const { unreadMessages, inbox, inboxHasFailures, workingNow } = useNavBadges();
    const tabs = mobileTabs(modules);
    const activeHref = activeNavHref(pathname, tabs);

    return (
        <nav
            aria-label="Primary"
            className="grid shrink-0 grid-cols-5 border-t border-border bg-sidebar/95 backdrop-blur-xl md:hidden"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
            {tabs.map((tab) => {
                const active = activeHref === tab.href;
                const Icon = TAB_ICONS[tab.id] ?? IconHome;
                const count = tab.badge === "inbox" ? inbox : tab.badge === "messages" ? unreadMessages : 0;
                const live = tab.badge === "live" && workingNow > 0;
                const label = tab.badge === "inbox" && count > 0 ? `${tab.name}, ${count} unread need you`
                    : tab.badge === "messages" && count > 0 ? `${tab.name}, ${count} unread`
                        : live ? `${tab.name}, ${workingNow} agents working now` : undefined;
                return (
                    <Link
                        key={tab.href}
                        href={tab.href}
                        aria-current={active ? "page" : undefined}
                        aria-label={label}
                        className={cn(
                            "relative flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors",
                            active ? "text-primary" : "text-muted-foreground active:text-foreground",
                        )}
                    >
                        {active && <span className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-primary" aria-hidden />}
                        <span className="relative">
                            <Icon className="h-5 w-5" />
                            {count > 0 && (
                                <span aria-hidden className={cn(
                                    "absolute -right-2.5 -top-1.5 min-w-4 rounded-full px-1 text-center text-[10px] font-bold leading-4",
                                    tab.badge === "inbox" ? (inboxHasFailures ? "bg-rose-500 text-white" : "bg-amber-400 text-amber-950") : "bg-primary text-primary-foreground",
                                )}>
                                    {count > 99 ? "99+" : count}
                                </span>
                            )}
                            {live && <span aria-hidden className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-cyan-400 ring-2 ring-sidebar" />}
                        </span>
                        {tab.name}
                    </Link>
                );
            })}
        </nav>
    );
}
