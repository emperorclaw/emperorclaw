"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { IconFolder, IconHome, IconInbox, IconMessage, IconRobot } from "@tabler/icons-react";
import { LayoutGroup, motion } from "framer-motion";
import { useNavBadges } from "@/components/use-nav-badges";
import { PopPresence } from "@/components/ui/motion";
import { activeNavHref, mobileTabs, type NavId } from "@/lib/navigation";
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
 * header menu. Fixed to the bottom in a translucent material so content
 * scrolls under it; .emperor-main pads its bottom by exactly the bar's
 * height (globals.css), so a chat composer still sits above it.
 */
export function MobileTabBar({ modules }: { modules?: ModuleState | null }) {
    const t = useTranslations();
    const pathname = usePathname();
    const { unreadMessages, inbox, inboxHasFailures, workingNow } = useNavBadges();
    const tabs = mobileTabs(modules);
    const activeHref = activeNavHref(pathname, tabs);

    return (
        <LayoutGroup id="mobile-tabs">
        <nav
            aria-label={t("shell.mobileTabs.primary")}
            className="ec-material ec-material-edge-top fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border md:hidden"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
            {tabs.map((tab) => {
                const active = activeHref === tab.href;
                const Icon = TAB_ICONS[tab.id] ?? IconHome;
                const count = tab.badge === "inbox" ? inbox : tab.badge === "messages" ? unreadMessages : 0;
                const live = tab.badge === "live" && workingNow > 0;
                const name = t(`nav.${tab.id as NavId}`);
                const label = tab.badge === "inbox" && count > 0 ? t("shell.mobileTabs.inboxUnread", { name, count })
                    : tab.badge === "messages" && count > 0 ? t("shell.mobileTabs.messagesUnread", { name, count })
                        : live ? t("shell.mobileTabs.workingNow", { name, count: workingNow }) : undefined;
                return (
                    <Link
                        key={tab.href}
                        href={tab.href}
                        aria-current={active ? "page" : undefined}
                        aria-label={label}
                        className={cn(
                            "relative isolate flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                            active ? "font-semibold text-foreground" : "font-medium text-muted-foreground active:text-foreground",
                        )}
                    >
                        {/* One shared indicator that glides to the active tab. */}
                        {active && <motion.span layoutId="mobile-tab-indicator" aria-hidden className="absolute inset-x-1.5 inset-y-1 -z-10 bg-black/[0.06] dark:bg-white/[0.11]" style={{ borderRadius: 10 }} />}
                        <span className="relative">
                            <Icon className={cn("h-5 w-5", active && "text-primary")} />
                            <PopPresence show={count > 0} className={cn(
                                "absolute -right-2.5 -top-1.5 min-w-4 rounded-full px-1 text-center text-[10px] font-bold leading-4",
                                tab.badge === "inbox" ? (inboxHasFailures ? "bg-rose-500 text-white" : "bg-amber-400 text-amber-950") : "bg-primary text-primary-foreground",
                            )}>
                                <span aria-hidden>{count > 99 ? "99+" : count}</span>
                            </PopPresence>
                            <PopPresence show={live} className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-cyan-400 ring-2 ring-sidebar">{null}</PopPresence>
                        </span>
                        {name}
                    </Link>
                );
            })}
        </nav>
        </LayoutGroup>
    );
}
