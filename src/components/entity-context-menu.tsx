"use client";

import { Fragment, type ComponentType, type ReactNode, type Ref } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
    IconArchive, IconArrowUpRight, IconBrain, IconClipboardText, IconCopy, IconHistory, IconLayoutKanban, IconLink, IconMail, IconMailOpened,
    IconMessage, IconSettings, IconShieldLock, IconUser,
} from "@tabler/icons-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";

type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/** One row of an entity's right-click menu: a link, or an action. */
export type EntityMenuEntry = {
    key: string;
    label: string;
    icon?: Icon;
    href?: string;
    onSelect?: () => void;
    destructive?: boolean;
    disabled?: boolean;
    /** Draw a separator above this row. */
    separated?: boolean;
};

/**
 * Right-click (and long-press on touch, and the keyboard's context-menu key)
 * menu for anything that represents an entity. The trigger is the child
 * itself (`asChild`), so the row keeps its own click, focus and test ids.
 */
export function EntityContextMenu({ ref, entries, children, label }: {
    /** Forwarded to the trigger (the child), e.g. for a MotionList item. */
    ref?: Ref<HTMLElement>;
    entries: EntityMenuEntry[];
    children: ReactNode;
    label?: string;
}) {
    if (entries.length === 0) return <>{children}</>;
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild ref={ref as Ref<HTMLSpanElement>}>{children}</ContextMenuTrigger>
            <ContextMenuContent aria-label={label} className="w-56">
                {entries.map((entry) => {
                    const Icon = entry.icon;
                    const body = <>{Icon && <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />}<span className="truncate">{entry.label}</span></>;
                    return (
                        <Fragment key={entry.key}>
                            {entry.separated && <ContextMenuSeparator />}
                            {entry.href ? (
                                <ContextMenuItem asChild disabled={entry.disabled} variant={entry.destructive ? "destructive" : "default"}>
                                    <Link href={entry.href}>{body}</Link>
                                </ContextMenuItem>
                            ) : (
                                <ContextMenuItem disabled={entry.disabled} variant={entry.destructive ? "destructive" : "default"} onSelect={entry.onSelect}>
                                    {body}
                                </ContextMenuItem>
                            )}
                        </Fragment>
                    );
                })}
            </ContextMenuContent>
        </ContextMenu>
    );
}

/** Copy `text` and confirm with a toast (or say it failed). */
export function useCopyToClipboard() {
    const t = useTranslations("contextMenu");
    return async (text: string, done: string) => {
        try {
            await navigator.clipboard.writeText(text);
            toast.success(done);
        } catch {
            toast.error(t("copyFailed"));
        }
    };
}

/** Absolute URL for an in-app path (what "Copy link" puts on the clipboard). */
export function absoluteUrl(path: string): string {
    return typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
}

/**
 * The agent menu: every entry deep-links to the real place (the agent
 * directory's detail tabs via `?agent=<id>&tab=<tab>`, the agent's direct
 * chat in Messages). `canMessage` follows the same rule as the chat composer.
 */
export function useAgentMenuEntries(agent: { id: string; name: string } | null | undefined, { canMessage = true, onMessage }: { canMessage?: boolean; onMessage?: () => void } = {}): EntityMenuEntry[] {
    const t = useTranslations("contextMenu");
    const copy = useCopyToClipboard();
    if (!agent) return [];
    const detail = (tab?: string) => `/agents?agent=${encodeURIComponent(agent.id)}${tab ? `&tab=${tab}` : ""}`;
    return [
        { key: "open", label: t("openDetails"), icon: IconUser, href: detail() },
        // On the Messages page itself the hub opens the chat in place (its `?agent=` deep link is read only on mount).
        ...(canMessage ? [onMessage ? { key: "message", label: t("message"), icon: IconMessage, onSelect: onMessage } : { key: "message", label: t("message"), icon: IconMessage, href: `/messages?agent=${encodeURIComponent(agent.id)}` }] : []),
        { key: "scope", label: t("scopes"), icon: IconShieldLock, href: detail("scope"), separated: true },
        { key: "instructions", label: t("instructions"), icon: IconClipboardText, href: detail("instructions") },
        { key: "memory", label: t("memory"), icon: IconBrain, href: detail("memory") },
        { key: "runs", label: t("runs"), icon: IconHistory, href: detail("runs") },
        { key: "copy-id", label: t("copyAgentId"), icon: IconCopy, onSelect: () => void copy(agent.id, t("agentIdCopied")), separated: true },
    ];
}

/** Right-click menu for an agent wherever it appears (card, row, avatar). */
export function AgentContextMenu({ ref, agent, canMessage, onMessage, children }: { ref?: Ref<HTMLElement>; agent: { id: string; name: string } | null | undefined; canMessage?: boolean; onMessage?: () => void; children: ReactNode }) {
    const entries = useAgentMenuEntries(agent, { canMessage, onMessage });
    return <EntityContextMenu ref={ref} entries={entries} label={agent?.name}>{children}</EntityContextMenu>;
}

/** Project menu: its board, its settings (when the viewer may edit), copy link. */
export function useProjectMenuEntries(project: { id: string } | null | undefined, { onSettings }: { onSettings?: () => void } = {}): EntityMenuEntry[] {
    const t = useTranslations("contextMenu");
    const copy = useCopyToClipboard();
    if (!project) return [];
    const href = `/projects?project=${encodeURIComponent(project.id)}`;
    return [
        { key: "board", label: t("board"), icon: IconLayoutKanban, href },
        ...(onSettings ? [{ key: "settings", label: t("settings"), icon: IconSettings, onSelect: onSettings }] : []),
        { key: "copy-link", label: t("copyLink"), icon: IconLink, onSelect: () => void copy(absoluteUrl(href), t("linkCopied")), separated: true },
    ];
}

/** Icons the per-page menus reuse (inbox, threads, customers). */
export const MENU_ICONS = { open: IconArrowUpRight, read: IconMailOpened, unread: IconMail, archive: IconArchive, link: IconLink, board: IconLayoutKanban, message: IconMessage };

/** Right-click menu for a project card or row. */
export function ProjectContextMenu({ ref, project, onSettings, children }: { ref?: Ref<HTMLElement>; project: { id: string; name?: string } | null | undefined; onSettings?: () => void; children: ReactNode }) {
    const entries = useProjectMenuEntries(project, { onSettings });
    return <EntityContextMenu ref={ref} entries={entries} label={project?.name}>{children}</EntityContextMenu>;
}
