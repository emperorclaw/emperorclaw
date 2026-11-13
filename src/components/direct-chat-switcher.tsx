"use client";

/**
 * Several private chats with one agent (docs/design/multi-chat-per-agent.md §6):
 * the chat bar above a direct chat (switcher, count hint, New chat, chat menu),
 * the "All chats" view, rename, and the dialog shown at the open-chat cap.
 * The chats themselves come from GET /api/chat/threads; changes go through
 * PATCH /api/chat/threads/[id]. Below md the switcher and "All chats" open as
 * bottom sheets.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
    IconArchive, IconCheck, IconChevronDown, IconDots, IconList, IconMessagePlus, IconPencil, IconRestore, IconSearch,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { useLivePoll } from "@/lib/use-realtime";
import {
    chatCountHint, filterChatsByTitle, groupChatsByRecency, leastRecentlyUsedChats, orderChats, switcherChats,
    CHAT_TITLE_MAX, type ChatListEntry,
} from "@/lib/multi-chat";
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheetContent } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MotionItem, MotionList, PopPresence } from "@/components/ui/motion";

const MOBILE_QUERY = "(max-width: 767px)";

function isMobileViewport(): boolean {
    return typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches;
}

export type AgentChatsState = {
    /** False until loaded, and when the person cannot use this agent's chats (403/404). */
    available: boolean;
    chats: ChatListEntry[];
    open: number;
    limit: number;
    /** The person may start another chat now (setting on, private mode). */
    multiChatEnabled: boolean;
};

const EMPTY_STATE: AgentChatsState = { available: false, chats: [], open: 0, limit: 0, multiChatEnabled: false };

/** List refresh while the person has extra chats or the switcher is open. */
const CHATS_POLL_MS = 15_000;
/** Otherwise the list follows invalidations; this is only a safety net. */
const CHATS_IDLE_POLL_MS = 10 * 60_000;

/**
 * The person's open chats with an agent, kept live: refetched on the agent's
 * and on every listed chat's invalidations, so unread dots and running or
 * queued markers cover all chats, not just the open one. The 15 s timer runs
 * only while the person has extra chats or is looking at the list
 * (`setWatching`); someone with just the main chat relies on invalidations.
 */
export function useAgentChats(agentId: string, enabled: boolean) {
    const [state, setState] = useState<AgentChatsState>(EMPTY_STATE);
    const [watching, setWatching] = useState(false);
    const activeRef = useRef(false);
    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/chat/threads?agentId=${encodeURIComponent(agentId)}`, { cache: "no-store" });
            if (!res.ok) {
                if (res.status === 403 || res.status === 404) setState(EMPTY_STATE);
                return;
            }
            const data = await res.json() as { chats?: ChatListEntry[]; open?: number; limit?: number; multiChatEnabled?: boolean };
            // Before the next timer is scheduled: a second chat switches the 15 s refresh on at once.
            if (Array.isArray(data.chats) && data.chats.length > 1) activeRef.current = true;
            setState({
                available: true,
                chats: Array.isArray(data.chats) ? data.chats : [],
                open: data.open ?? 0,
                limit: data.limit ?? 0,
                multiChatEnabled: data.multiChatEnabled === true,
            });
        } catch {
            // Transient: keep the last list.
        }
    }, [agentId]);
    const topics = useMemo(() => ["agents", ...state.chats.map((chat) => `thread:${chat.id}`)], [state.chats]);
    useEffect(() => {
        activeRef.current = watching || state.chats.length > 1;
    });
    const { pollNow } = useLivePoll(() => load(), {
        fastMs: () => (activeRef.current ? CHATS_POLL_MS : CHATS_IDLE_POLL_MS),
        slowMs: CHATS_POLL_MS,
        topics, enabled, resetKey: load,
    });
    // Opening the list: refresh it now, then keep it fresh while it is open.
    useEffect(() => {
        if (watching) pollNow();
    }, [watching, pollNow]);
    return { ...state, reload: pollNow, reloadNow: load, setWatching };
}

/** A chat's name as the person sees it. */
export function useChatLabel() {
    const t = useTranslations("directChat.chats");
    return useCallback((chat: Pick<ChatListEntry, "isMain" | "title">) => (chat.isMain ? t("mainChat") : chat.title?.trim() || t("untitled")), [t]);
}

/** Why a chat is archived, in words. */
export function useArchiveReasonLabel() {
    const t = useTranslations("directChat.chats.archiveReason");
    return useCallback((reason: string | null | undefined) => {
        switch (reason) {
            case "idle": return t("idle");
            case "member_left": return t("member_left");
            case "agent_sealed": return t("agent_sealed");
            default: return t("manual");
        }
    }, [t]);
}

export type ChatPatchResult = { ok: true } | { ok: false; code: string | null; error: string };

/** PATCH /api/chat/threads/[id] with one change. */
export async function patchChat(threadId: string, body: { title: string } | { archived: boolean }): Promise<ChatPatchResult> {
    try {
        const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        if (res.ok) return { ok: true };
        const data = await res.json().catch(() => ({})) as { error?: string; code?: string };
        return { ok: false, code: data.code ?? null, error: data.error ?? "" };
    } catch {
        return { ok: false, code: null, error: "" };
    }
}

/** The message for a refused chat change, by its code. */
export function useChatErrorMessage() {
    const t = useTranslations("directChat.chats.errors");
    return useCallback((result: { code: string | null; error: string }) => {
        switch (result.code) {
            case "chat_limit_reached": return t("limitReached");
            case "multi_chat_disabled": return t("disabled");
            case "main_chat_cannot_be_archived": return t("mainCannotArchive");
            case "main_chat_cannot_be_renamed": return t("mainCannotRename");
            case "chat_archived": return t("archived");
            case "rate_limited": return t("rateLimited");
            case "objective_running": return t("objectiveRunning");
            default: return result.error || t("generic");
        }
    }, [t]);
}

/** Running / queued marker and unread dot for one chat row. */
function ChatRowStatus({ chat }: { chat: ChatListEntry }) {
    const t = useTranslations("directChat.chats");
    return (
        <span className="flex shrink-0 items-center gap-1.5">
            {chat.running ? (
                <span className="flex items-center gap-1 text-[10px] text-emerald-400">
                    <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                    {t("working")}
                </span>
            ) : chat.queued > 0 ? (
                <span className="text-[10px] text-amber-300">{t("queuedCount", { count: chat.queued })}</span>
            ) : null}
            <PopPresence show={chat.unread > 0} className="min-w-5 rounded-full bg-cyan-400 px-1.5 py-0.5 text-center text-[10px] font-bold text-cyan-950">
                <span aria-hidden>{chat.unread}</span>
                <span className="sr-only">{t("unread", { count: chat.unread })}</span>
            </PopPresence>
        </span>
    );
}

function ChatRowBody({ chat, current, sub }: { chat: ChatListEntry; current: boolean; sub: ReactNode }) {
    const label = useChatLabel();
    return (
        <>
            <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-sm font-medium", current ? "text-cyan-100" : "text-zinc-200")}>{label(chat)}</span>
                <span className="block truncate text-[10px] text-zinc-500">{sub}</span>
            </span>
            <ChatRowStatus chat={chat} />
            {current && <IconCheck aria-hidden className="h-4 w-4 shrink-0 text-cyan-400" />}
        </>
    );
}

/** "5m ago" / "Oct 29" for a chat's last activity. */
function useChatTime() {
    const t = useTranslations("directChat.chats");
    const format = useFormatter();
    return (chat: ChatListEntry) => {
        const at = chat.lastMessageAt ?? chat.createdAt;
        if (!chat.lastMessageAt) return t("noMessages");
        return format.relativeTime(new Date(at), new Date());
    };
}

export function DirectChatBar({
    agentId,
    agentName,
    chats,
    currentThreadId,
    currentIsArchived,
    currentThread,
    newChatActive,
    canStartNew,
    onSelect,
    onNewChat,
    onChanged,
    onArchivedCurrent,
}: {
    agentId: string;
    agentName: string;
    chats: AgentChatsState & { reload: () => void; setWatching?: (watching: boolean) => void };
    /** The chat on screen (null while a New chat composer is open, or before the main chat loads). */
    currentThreadId: string | null;
    currentIsArchived: boolean;
    /** The chat on screen as loaded (an archived chat is not in the open list): its title in the header. */
    currentThread?: Pick<ChatListEntry, "isMain" | "title"> | null;
    newChatActive: boolean;
    canStartNew: boolean;
    onSelect: (threadId: string) => void;
    onNewChat: () => void;
    /** A chat was renamed, archived or restored: refresh what depends on it. */
    onChanged: (threadId: string) => void;
    onArchivedCurrent?: () => void;
}) {
    const t = useTranslations("directChat.chats");
    const label = useChatLabel();
    const chatTime = useChatTime();
    const errorMessage = useChatErrorMessage();
    const [menuOpen, setMenuOpen] = useState(false);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [allOpen, setAllOpen] = useState(false);
    const [renaming, setRenaming] = useState<ChatListEntry | null>(null);
    const [error, setError] = useState<string | null>(null);

    const current = chats.chats.find((chat) => chat.id === currentThreadId) ?? null;
    const { shown, more } = switcherChats(chats.chats);
    const hint = chatCountHint(chats.open, chats.limit);
    const otherUnread = chats.chats.some((chat) => chat.id !== currentThreadId && chat.unread > 0);
    const shownThread = current ?? currentThread ?? null;
    const title = newChatActive ? t("newChat") : shownThread ? label(shownThread) : currentIsArchived ? t("archivedChat") : t("mainChat");
    const setWatching = chats.setWatching;
    useEffect(() => {
        setWatching?.(menuOpen || sheetOpen || allOpen);
    }, [menuOpen, sheetOpen, allOpen, setWatching]);
    // Dialogs opened from a menu would return focus to the (gone) menu item: send it back to the switcher.
    const triggerRef = useRef<HTMLButtonElement>(null);
    const returnFocus = useCallback((event: Event) => {
        event.preventDefault();
        triggerRef.current?.focus();
    }, []);

    const openSwitcher = (next: boolean) => {
        if (next && isMobileViewport()) {
            setSheetOpen(true);
            return;
        }
        setMenuOpen(next);
    };
    const pick = (threadId: string) => {
        setMenuOpen(false);
        setSheetOpen(false);
        setAllOpen(false);
        onSelect(threadId);
    };
    const openAll = () => {
        setMenuOpen(false);
        setSheetOpen(false);
        setAllOpen(true);
    };

    const archive = async (chat: ChatListEntry) => {
        setError(null);
        const result = await patchChat(chat.id, { archived: true });
        if (!result.ok) {
            setError(errorMessage(result));
            return;
        }
        chats.reload();
        onChanged(chat.id);
        if (chat.id === currentThreadId) onArchivedCurrent?.();
    };

    const switcherList = (asMenu: boolean) => (
        <>
            {shown.map((chat) => {
                const body = <ChatRowBody chat={chat} current={chat.id === currentThreadId && !newChatActive} sub={chatTime(chat)} />;
                return asMenu ? (
                    <DropdownMenuItem key={chat.id} onSelect={() => pick(chat.id)} className="min-h-11 cursor-pointer rounded-lg px-2.5 py-2 focus:bg-cyan-400/10 focus:text-zinc-100">
                        {body}
                    </DropdownMenuItem>
                ) : (
                    <button key={chat.id} type="button" onClick={() => pick(chat.id)}
                        className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-zinc-900/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70">
                        {body}
                    </button>
                );
            })}
        </>
    );

    const isMainCurrent = Boolean(current?.isMain);
    const menuDisabledReason = isMainCurrent ? t("mainChatLocked") : null;

    return (
        <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/60 px-2 sm:px-4">
            <DropdownMenu open={menuOpen} onOpenChange={openSwitcher}>
                <DropdownMenuTrigger asChild>
                    <button
                        ref={triggerRef}
                        type="button"
                        aria-label={t("switcherLabel", { title })}
                        aria-haspopup="menu"
                        className="group flex min-h-11 min-w-0 items-center gap-1.5 rounded-xl px-2 text-left transition-colors hover:bg-zinc-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                    >
                        <span className="truncate text-sm font-medium text-zinc-100">{title}</span>
                        {currentIsArchived && !newChatActive && (
                            <span className="shrink-0 rounded-full border border-zinc-700 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">{t("archivedBadge")}</span>
                        )}
                        <PopPresence show={otherUnread} className="h-2 w-2 shrink-0 rounded-full bg-cyan-400">
                            <span className="sr-only">{t("otherUnread")}</span>
                        </PopPresence>
                        <IconChevronDown aria-hidden className="h-4 w-4 shrink-0 text-zinc-500 transition-colors group-hover:text-zinc-300" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-80 rounded-xl border-zinc-800 bg-zinc-950 p-1.5 text-zinc-200 shadow-2xl shadow-black/50">
                    <DropdownMenuLabel className="flex items-center justify-between px-2.5 py-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-600">
                        {t("chatsWith", { name: agentName })}
                        {hint && <span className="normal-case tracking-normal tabular-nums">{t("countHint", hint)}</span>}
                    </DropdownMenuLabel>
                    {switcherList(true)}
                    <DropdownMenuSeparator className="my-1.5 bg-zinc-800" />
                    <DropdownMenuItem onSelect={openAll} className="min-h-11 cursor-pointer rounded-lg px-2.5 py-2 focus:bg-cyan-400/10 focus:text-zinc-100">
                        <IconList aria-hidden className="h-4 w-4" />
                        <span className="flex-1">{more > 0 ? t("allChatsMore", { count: more }) : t("allChats")}</span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {hint && (
                <span className="hidden shrink-0 text-[11px] tabular-nums text-zinc-500 sm:inline">
                    <span aria-hidden>{t("countHint", hint)}</span>
                    <span className="sr-only">{t("countHintLabel", hint)}</span>
                </span>
            )}

            <div className="ml-auto flex shrink-0 items-center gap-1">
                {canStartNew && !newChatActive && (
                    <button
                        type="button"
                        onClick={onNewChat}
                        aria-label={t("newChat")}
                        title={t("newChat")}
                        className="flex h-11 items-center gap-1.5 rounded-xl px-2.5 text-xs text-zinc-400 transition-colors hover:bg-cyan-400/10 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                    >
                        <IconMessagePlus aria-hidden className="h-4 w-4" />
                        <span className="hidden sm:inline">{t("newChat")}</span>
                    </button>
                )}
                {current && !newChatActive && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                aria-label={t("chatMenu")}
                                title={t("chatMenu")}
                                className="grid h-11 w-11 place-items-center rounded-xl text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                            >
                                <IconDots aria-hidden className="h-4 w-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64 rounded-xl border-zinc-800 bg-zinc-950 p-1.5 text-zinc-200">
                            <DropdownMenuItem disabled={isMainCurrent || currentIsArchived} onSelect={() => setRenaming(current)} className="min-h-11 rounded-lg px-2.5">
                                <IconPencil aria-hidden className="h-4 w-4" />{t("rename")}
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={isMainCurrent || currentIsArchived} onSelect={() => void archive(current)} className="min-h-11 rounded-lg px-2.5">
                                <IconArchive aria-hidden className="h-4 w-4" />{t("archive")}
                            </DropdownMenuItem>
                            {menuDisabledReason && (
                                <p className="px-2.5 pb-1.5 pt-1 text-[11px] leading-snug text-zinc-500">{menuDisabledReason}</p>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>

            {/* Phones: the switcher as a bottom sheet. */}
            <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
                <BottomSheetContent onDismiss={() => setSheetOpen(false)} onCloseAutoFocus={returnFocus}
                    header={<DialogTitle className="text-base">{t("chatsWith", { name: agentName })}</DialogTitle>}>
                    <DialogDescription className="sr-only">{t("switcherDescription")}</DialogDescription>
                    {hint && <p className="mb-2 text-xs tabular-nums text-muted-foreground">{t("countHint", hint)}</p>}
                    <div className="space-y-1">{switcherList(false)}</div>
                    <button type="button" onClick={openAll}
                        className="mt-2 flex min-h-12 w-full items-center gap-2 rounded-xl border border-zinc-800 px-3 text-sm text-zinc-300 hover:border-cyan-400/40 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70">
                        <IconList aria-hidden className="h-4 w-4" />
                        {more > 0 ? t("allChatsMore", { count: more }) : t("allChats")}
                    </button>
                </BottomSheetContent>
            </Dialog>

            {allOpen && (
                <AllChatsView
                    agentId={agentId}
                    agentName={agentName}
                    chats={chats}
                    currentThreadId={newChatActive ? null : currentThreadId}
                    onClose={() => setAllOpen(false)}
                    onPick={pick}
                    onChanged={onChanged}
                    onCloseAutoFocus={returnFocus}
                />
            )}
            {renaming && (
                <RenameChatDialog
                    chat={renaming}
                    onCloseAutoFocus={returnFocus}
                    onClose={() => setRenaming(null)}
                    onRenamed={() => { setRenaming(null); chats.reload(); onChanged(renaming.id); }}
                />
            )}
            {error && (
                <Dialog open onOpenChange={(next) => { if (!next) setError(null); }}>
                    <DialogContent className="sm:max-w-md" onCloseAutoFocus={returnFocus}>
                        <DialogHeader>
                            <DialogTitle>{t("errors.title")}</DialogTitle>
                            <DialogDescription>{error}</DialogDescription>
                        </DialogHeader>
                        <DialogFooter><Button type="button" onClick={() => setError(null)} autoFocus>{t("ok")}</Button></DialogFooter>
                    </DialogContent>
                </Dialog>
            )}
        </div>
    );
}

/** A dialog on desktop, a bottom sheet on phones (chosen when it opens). */
function ResponsiveDialog({ title, description, onClose, children, wide, onCloseAutoFocus }: {
    title: string; description: string; onClose: () => void; children: ReactNode; wide?: boolean;
    onCloseAutoFocus?: (event: Event) => void;
}) {
    const [mobile] = useState(isMobileViewport);
    return (
        <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
            {mobile ? (
                <BottomSheetContent onDismiss={onClose} onCloseAutoFocus={onCloseAutoFocus} header={<DialogTitle className="text-base">{title}</DialogTitle>}>
                    <DialogDescription className="sr-only">{description}</DialogDescription>
                    {children}
                </BottomSheetContent>
            ) : (
                <DialogContent onCloseAutoFocus={onCloseAutoFocus} className={cn("max-h-[85dvh] overflow-hidden", wide ? "sm:max-w-xl" : "sm:max-w-md")}>
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        <DialogDescription>{description}</DialogDescription>
                    </DialogHeader>
                    {children}
                </DialogContent>
            )}
        </Dialog>
    );
}

function AllChatsView({ agentId, agentName, chats, currentThreadId, onClose, onPick, onChanged, onCloseAutoFocus }: {
    agentId: string;
    agentName: string;
    chats: AgentChatsState & { reload: () => void };
    currentThreadId: string | null;
    onClose: () => void;
    onPick: (threadId: string) => void;
    onChanged: (threadId: string) => void;
    onCloseAutoFocus?: (event: Event) => void;
}) {
    const t = useTranslations("directChat.chats");
    const label = useChatLabel();
    const chatTime = useChatTime();
    const reasonLabel = useArchiveReasonLabel();
    const errorMessage = useChatErrorMessage();
    const format = useFormatter();
    const [query, setQuery] = useState("");
    const [archived, setArchived] = useState<ChatListEntry[] | null>(null);
    const [loadingArchived, setLoadingArchived] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const ordered = orderChats(chats.chats);
    const main = ordered.find((chat) => chat.isMain) ?? null;
    const extras = filterChatsByTitle(ordered.filter((chat) => !chat.isMain), query, label);
    const groups = groupChatsByRecency(extras);
    const showMain = main && filterChatsByTitle([main], query, label).length > 0;
    const archivedShown = archived ? filterChatsByTitle(archived, query, label) : [];

    const loadArchived = async () => {
        setLoadingArchived(true);
        try {
            const res = await fetch(`/api/chat/threads?agentId=${encodeURIComponent(agentId)}&archived=1`, { cache: "no-store" });
            const data = res.ok ? await res.json() as { chats?: ChatListEntry[] } : { chats: [] };
            setArchived(Array.isArray(data.chats) ? data.chats : []);
        } catch {
            setArchived([]);
        } finally {
            setLoadingArchived(false);
        }
    };

    const restore = async (chat: ChatListEntry) => {
        setBusyId(chat.id);
        setError(null);
        const result = await patchChat(chat.id, { archived: false });
        setBusyId(null);
        if (!result.ok) {
            setError(errorMessage(result));
            return;
        }
        setArchived((list) => list?.filter((entry) => entry.id !== chat.id) ?? null);
        chats.reload();
        onChanged(chat.id);
    };

    const row = (chat: ChatListEntry) => (
        <MotionItem key={chat.id} as="button" type="button" onClick={() => onPick(chat.id)}
            className={cn(
                "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70",
                chat.id === currentThreadId ? "border border-cyan-400/30 bg-cyan-400/10" : "border border-transparent hover:bg-zinc-900/70",
            )}>
            <ChatRowBody chat={chat} current={chat.id === currentThreadId} sub={chatTime(chat)} />
        </MotionItem>
    );
    const section = (heading: string, list: ChatListEntry[]) => list.length > 0 && (
        <section aria-label={heading}>
            <h3 className="mb-1 mt-3 px-3 text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-600">{heading}</h3>
            <MotionList>{list.map(row)}</MotionList>
        </section>
    );

    return (
        <ResponsiveDialog title={t("allChatsTitle", { name: agentName })} description={t("allChatsDescription")} onClose={onClose} onCloseAutoFocus={onCloseAutoFocus} wide>
            <div className="relative">
                <IconSearch aria-hidden className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("filterPlaceholder")} aria-label={t("filterLabel")} className="h-11 pl-9" />
            </div>
            <div className="fade-y -mx-1 max-h-[55dvh] overflow-y-auto px-1 pb-1">
                {showMain && main && <div className="mt-2">{row(main)}</div>}
                {section(t("groups.today"), groups.today)}
                {section(t("groups.last7Days"), groups.last7Days)}
                {section(t("groups.older"), groups.older)}
                {!showMain && extras.length === 0 && <p className="px-3 py-6 text-center text-xs text-zinc-500">{t("noMatches")}</p>}

                <section aria-label={t("archivedSection")} className="mt-4 border-t border-zinc-800 pt-2">
                    <h3 className="mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-600">{t("archivedSection")}</h3>
                    {archived === null ? (
                        <button type="button" onClick={() => void loadArchived()} disabled={loadingArchived}
                            className="min-h-11 rounded-lg px-3 text-xs text-cyan-300 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 disabled:opacity-50">
                            {loadingArchived ? t("loading") : t("showArchived")}
                        </button>
                    ) : archivedShown.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-zinc-500">{t("noArchived")}</p>
                    ) : (
                        <MotionList>
                            {archivedShown.map((chat) => (
                                <MotionItem key={chat.id} className="flex min-h-12 items-center gap-2 rounded-xl px-1">
                                    <button type="button" onClick={() => onPick(chat.id)}
                                        className="min-w-0 flex-1 rounded-lg px-2 py-2 text-left hover:bg-zinc-900/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70">
                                        <span className="block truncate text-sm text-zinc-300">{label(chat)}</span>
                                        <span className="block truncate text-[10px] text-zinc-500">
                                            {reasonLabel(chat.archiveReason)}
                                            {chat.archivedAt && <> · {format.dateTime(new Date(chat.archivedAt), { month: "short", day: "numeric" })}</>}
                                        </span>
                                    </button>
                                    <Button type="button" variant="outline" size="sm" disabled={busyId === chat.id} onClick={() => void restore(chat)}
                                        aria-label={t("restoreNamed", { title: label(chat) })} className="min-h-11 shrink-0">
                                        <IconRestore aria-hidden className="h-4 w-4" />{t("restore")}
                                    </Button>
                                </MotionItem>
                            ))}
                        </MotionList>
                    )}
                </section>
                {error && <p role="alert" className="mt-2 px-3 text-xs text-red-300">{error}</p>}
            </div>
        </ResponsiveDialog>
    );
}

function RenameChatDialog({ chat, onClose, onRenamed, onCloseAutoFocus }: {
    chat: ChatListEntry; onClose: () => void; onRenamed: () => void; onCloseAutoFocus?: (event: Event) => void;
}) {
    const t = useTranslations("directChat.chats");
    const errorMessage = useChatErrorMessage();
    const [title, setTitle] = useState(chat.title ?? "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        const next = title.trim();
        if (!next || saving) return;
        setSaving(true);
        setError(null);
        const result = await patchChat(chat.id, { title: next });
        setSaving(false);
        if (result.ok) onRenamed();
        else setError(errorMessage(result));
    };
    return (
        <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
            <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
                <form onSubmit={submit} className="grid gap-4">
                    <DialogHeader>
                        <DialogTitle>{t("renameTitle")}</DialogTitle>
                        <DialogDescription>{t("renameDescription")}</DialogDescription>
                    </DialogHeader>
                    <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={CHAT_TITLE_MAX * 2} aria-label={t("renameLabel")} autoFocus className="h-11" />
                    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>{t("cancel")}</Button>
                        <Button type="submit" disabled={!title.trim() || saving}>{t("save")}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/**
 * The open-chat cap was reached: the least recently used chats with an
 * Archive action each, then "Try again" resends the first message.
 */
export function ChatLimitDialog({ limit, open, chats, onArchived, onRetry, onClose }: {
    limit: number;
    open: number;
    chats: ChatListEntry[];
    onArchived: (threadId: string) => void;
    onRetry: () => void;
    onClose: () => void;
}) {
    const t = useTranslations("directChat.chats");
    const label = useChatLabel();
    const chatTime = useChatTime();
    const errorMessage = useChatErrorMessage();
    const [archivedIds, setArchivedIds] = useState<string[]>([]);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const suggestions = leastRecentlyUsedChats(chats);

    const archive = async (chat: ChatListEntry) => {
        setBusyId(chat.id);
        setError(null);
        const result = await patchChat(chat.id, { archived: true });
        setBusyId(null);
        if (!result.ok) {
            setError(errorMessage(result));
            return;
        }
        setArchivedIds((ids) => [...ids, chat.id]);
        onArchived(chat.id);
    };

    return (
        <ResponsiveDialog title={t("limitTitle")} description={t("limitDescription", { open, limit })} onClose={onClose}>
            {suggestions.length === 0 ? (
                <p className="text-xs text-zinc-500">{t("limitNoSuggestions")}</p>
            ) : (
                <ul className="space-y-1" aria-label={t("limitListLabel")}>
                    {suggestions.map((chat) => {
                        const done = archivedIds.includes(chat.id);
                        return (
                            <li key={chat.id} className="flex min-h-12 items-center gap-2 rounded-xl border border-zinc-800 px-3 py-1.5">
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm text-zinc-200">{label(chat)}</span>
                                    <span className="block text-[10px] text-zinc-500">{chatTime(chat)}</span>
                                </span>
                                <Button type="button" variant="outline" size="sm" disabled={done || busyId === chat.id} onClick={() => void archive(chat)}
                                    aria-label={t("archiveNamed", { title: label(chat) })} className="min-h-11 shrink-0">
                                    {done ? <IconCheck aria-hidden className="h-4 w-4" /> : <IconArchive aria-hidden className="h-4 w-4" />}
                                    {done ? t("archivedDone") : t("archive")}
                                </Button>
                            </li>
                        );
                    })}
                </ul>
            )}
            {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
            <DialogFooter className="mt-2">
                <Button type="button" variant="outline" onClick={onClose}>{t("cancel")}</Button>
                <Button type="button" disabled={archivedIds.length === 0} onClick={onRetry}>{t("tryAgain")}</Button>
            </DialogFooter>
        </ResponsiveDialog>
    );
}
