"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useSession } from "next-auth/react";
import { useFormatter, useTranslations } from "next-intl";
import { useCopy } from "@/lib/i18n/use-copy";
import { IconArchive, IconArrowUp, IconPaperclip, IconPlayerStop, IconRestore, IconRobot, IconMicrophone, IconSend, IconSquare, IconTrash, IconUser } from "@tabler/icons-react";
import { DeliveryInspector } from "@/components/delivery-inspector";
import { ApprovalCard } from "@/components/approval-card";
import { TypingReveal } from "@/components/typing-reveal";
import { markLiveReveal } from "@/lib/typing-reveal";
import { useLiveArrivals } from "@/lib/use-live-arrivals";
import { useChatEnter } from "@/lib/chat-enter";
import { approvalCardIdOf } from "@/lib/approval-card-copy";
import { isPersistedUuid } from "@/lib/run-ledger-copy";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { RichMessageActionsContext } from "@/components/rich/rich-message-actions";
import { hasChoicesBlock, hasRichBlocks } from "@/lib/rich-blocks";
import { AttachmentChip, isAttachmentRef, type AttachmentRef } from "@/components/chat-attachments";
import { MessageReasoningDisclosure } from "@/components/message-reasoning-disclosure";
import { queuePromptPreview } from "@/lib/queue-prompt-preview";
import { takeChatDraft } from "@/lib/chat-draft";
import { AgentGoalControls } from "@/components/agent-goal-controls";
import { requestSourceCopy, requestSourceLabel } from "@/lib/request-label";
import { LiveStatusRow } from "@/components/live-status-row";
import { FadeRise, MotionItem, MotionList, Presence, TextSwap } from "@/components/ui/motion";
import { LiveRunSteps, ReplyRunFooter, type ReplyRun } from "@/components/run-timeline";
import { chatPollDelayMs, eventsSinceParam, formatElapsed, isTimedStepKind, lastReasoningCopy, lastReasoningLine, mergeLiveRuns, runningRun, type ClientLiveRun } from "@/lib/live-activity";
import { useLivePoll } from "@/lib/use-realtime";
import { summarizeAlsoWorking, type RunningRun } from "@/lib/agent-visibility";
import type { RunLive } from "@/lib/run-events";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { refreshNavBadges } from "@/components/use-nav-badges";
import { ChatLimitDialog, DirectChatBar, patchChat, useAgentChats, useArchiveReasonLabel, useChatErrorMessage, useChatLabel } from "@/components/direct-chat-switcher";
import { newChatClientKey, queuedBusyState } from "@/lib/multi-chat";
import { readPendingNewChatKey, readThreadDraft, writePendingNewChatKey, writeThreadDraft } from "@/lib/chat-selection";

const composerIconButton = "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const CHAT_PAGE_SIZE = 25;

type DirectThread = {
    id: string;
    type: string;
    title: string | null;
    createdAt: string;
    /** Private mode: the person's own chat (set) vs. the agent's shared/Operations thread (null). */
    ownerUserId?: string | null;
    isMain?: boolean;
    archivedAt?: string | null;
    archiveReason?: string | null;
};

/** The chat on screen as one key: a New chat composer, a chat by id, or the main chat (null id). */
function chatViewKey(threadId: string | null, newChatKey: string | null): string {
    return newChatKey ? `new:${newChatKey}` : threadId ?? "main";
}

/** GET /api/chat `runtime` for direct chats (multi-chat P1). */
type ChatRuntime = {
    /** What Stop in this chat stops: this chat, or all of the agent's chats (older runtime). */
    stopScope: "thread" | "agent";
    /** Chats the runtime answers at once; null when it does not say. */
    maxParallelTurns: number | null;
    /** The viewer may stop the agent in every chat (owners, admins, the agent's owner). */
    canStopAll?: boolean;
};

/** A refused POST /api/chat: `{ error, code, ...extra }`. */
class ChatSendError extends Error {
    constructor(message: string, readonly code: string | null, readonly extra: Record<string, unknown>) {
        super(message);
    }
}

async function throwSendError(res: Response, fallback: string): Promise<never> {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    const { error, code, ...extra } = data;
    throw new ChatSendError(typeof error === "string" && error ? error : fallback, typeof code === "string" ? code : null, extra);
}

type DirectMessage = {
    id: string;
    senderType: "human" | "agent" | "system";
    senderId?: string | null;
    fromUserId?: string | null;
    text: string;
    createdAt: string;
    metadataJson?: unknown;
    deliveryState?: "queued" | "seen" | "acting" | "resolved" | string | null;
};

function getMessageAttachments(message: DirectMessage): AttachmentRef[] {
    if (!message.metadataJson || typeof message.metadataJson !== "object") return [];
    const raw = (message.metadataJson as Record<string, unknown>).attachments;
    if (!Array.isArray(raw)) return [];
    return raw.filter(isAttachmentRef);
}

// A flag, not the transcript: the reasoning itself is never part of the message
// list payload. It says only whether the disclosure is worth offering.
function hasStoredReasoning(message: DirectMessage): boolean {
    if (!message.metadataJson || typeof message.metadataJson !== "object") return false;
    return (message.metadataJson as Record<string, unknown>).hasReasoning === true;
}

function getMessageSenderName(message: DirectMessage): string | null {
    if (!message.metadataJson || typeof message.metadataJson !== "object") return null;
    const name = (message.metadataJson as Record<string, unknown>).senderName;
    return typeof name === "string" && name.trim() ? name : null;
}

type DirectParticipant = {
    participantType: "human" | "agent" | "system" | string;
    typingUntil?: string | null;
    lastReadAt?: string | null;
    currentActivity?: string | null;
};

// --- Grouping helpers ---

function isSameDay(a: string | Date, b: string | Date) {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function isGroupContinuation(
    curr: { senderType: string; senderId?: string | null; fromUserId?: string | null; createdAt: string | Date },
    prev: typeof curr
) {
    if (curr.senderType !== prev.senderType) return false;
    const currId = curr.senderId ?? curr.fromUserId ?? null;
    const prevId = prev.senderId ?? prev.fromUserId ?? null;
    if (currId !== prevId) return false;
    return (new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime()) < 5 * 60 * 1000;
}

/** "Today", "Yesterday" or "Oct 29", in the viewer's language. */
function useDateSeparatorLabel() {
    const t = useTranslations("teamChat");
    const format = useFormatter();
    return (date: string | Date) => {
        const d = new Date(date);
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        if (isSameDay(d, today)) return t("today");
        if (isSameDay(d, yesterday)) return t("yesterday");
        return format.dateTime(d, { month: "short", day: "numeric" });
    };
}

export function AgentDirectChat({
    agentId,
    agentName,
    hideHeader = false,
    canSend = true,
    onAgentReply,
    directThreadId = null,
    onThreadChange,
    onUnreadTotal,
    showStopAll = false,
}: {
    agentId: string;
    agentName: string;
    hideHeader?: boolean;
    /** A specific direct thread of this agent (its Operations thread, or one of the viewer's chats); default: the viewer's main chat. */
    directThreadId?: string | null;
    canSend?: boolean;
    onAgentReply?: (message: { text: string; createdAt: string }) => void;
    /**
     * The viewer switched to another of their chats with the agent (null: back to the main chat).
     * `archived`: the chat on screen is archived (true) or was just restored (false); an archived
     * chat is not remembered as the chat to reopen.
     */
    onThreadChange?: (threadId: string | null, info?: { archived?: boolean }) => void;
    /** Unread messages across all of the viewer's open chats with the agent, kept live. */
    onUnreadTotal?: (count: number) => void;
    /** The agent page: offer "Stop all chats" (agent-wide) to those allowed to use it. */
    showStopAll?: boolean;
}) {
    const t = useTranslations("directChat");
    const render = useCopy();
    const tTeam = useTranslations("teamChat");
    const format = useFormatter();
    const dateSeparatorLabel = useDateSeparatorLabel();
    const failureLabel = (message: DirectMessage) => {
        const failure = runtimeFailureOf(message);
        if (!failure) return null;
        return failure.attempts ? t("failedAfter", { count: failure.attempts }) : t("failed");
    };
    const tChats = useTranslations("directChat.chats");
    const chatLabel = useChatLabel();
    const archiveReasonLabel = useArchiveReasonLabel();
    const chatErrorMessage = useChatErrorMessage();
    const { data: session } = useSession();
    // session.user.id is set in the auth session callback at runtime but not
    // part of next-auth's default user type — access it with the same cast the
    // rest of the codebase uses for augmented session fields.
    const currentUserId = (session?.user as { id?: string } | undefined)?.id;
    const [thread, setThread] = useState<DirectThread | null>(null);
    const [messages, setMessages] = useState<DirectMessage[]>([]);
    useEffect(() => {
        if (!onAgentReply) return;
        for (const message of messages) {
            if (message.senderType === "agent" && message.senderId === agentId) onAgentReply(message);
        }
    }, [messages, agentId, onAgentReply]);
    const [participants, setParticipants] = useState<DirectParticipant[]>([]);
    // 0.9 run events: the thread's live runs (merged across polls) and the run
    // behind each agent reply (footer). Both stay empty against older servers.
    const [liveRuns, setLiveRuns] = useState<ClientLiveRun[]>([]);
    const liveRunsRef = useRef<ClientLiveRun[]>([]);
    const [replyRuns, setReplyRuns] = useState<Record<string, ReplyRun>>({});
    // The agent's running runs across all of its threads, for the "Also working
    // on" row and the busy/queued signal.
    const [runningRuns, setRunningRuns] = useState<RunningRun[]>([]);
    // The chat on screen: one of the viewer's chats by id, or null = the main chat
    // (resolved by the server). `newChatKey` is set while a New chat composer is
    // open: nothing exists until its first message is sent with that key.
    const [activeThreadId, setActiveThreadId] = useState<string | null>(directThreadId);
    const [newChatKey, setNewChatKey] = useState<string | null>(null);
    // One AgentDirectChat serves every chat with this agent, so every async
    // result (a load, a send, a voice note, a delayed poll) carries the chat it
    // was for and is dropped when another chat is on screen by then. The key is
    // updated synchronously by every switch (chatViewKey).
    const viewKeyRef = useRef(chatViewKey(directThreadId, null));
    // Delayed polls after a send: cleared on every chat switch.
    const pollTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
    useEffect(() => {
        setActiveThreadId(directThreadId);
        setNewChatKey(null);
        const next = chatViewKey(directThreadId, null);
        if (viewKeyRef.current !== next) {
            viewKeyRef.current = next;
            clearScheduledPolls();
            clearComposerMedia();
            setPendingAttachments([]);
        }
    }, [directThreadId]);
    // Set when a New chat's first message created the thread: keep what is on screen while it loads.
    const keepMessagesRef = useRef(false);
    // Bumped whenever the view is cleared for another chat: a response for the previous one is dropped.
    const viewGenerationRef = useRef(0);
    const [runtime, setRuntime] = useState<ChatRuntime | null>(null);
    const [limitReached, setLimitReached] = useState<{ limit: number; open: number } | null>(null);
    const [confirmStop, setConfirmStop] = useState<"chat" | "all" | null>(null);
    const [restoring, setRestoring] = useState(false);
    const [draft, setDraft] = useState("");
    // A draft another page handed over (e.g. "Ask about this panel"): prefilled in the main chat, never sent.
    // It wins over a draft stored for the main chat once that chat's id is known (see the draftKey effect).
    const handedDraftRef = useRef<string | null>(null);
    useEffect(() => {
        if (directThreadId) return;
        const handed = takeChatDraft(agentId);
        if (handed) {
            handedDraftRef.current = handed;
            setDraft(handed);
        }
    }, [agentId, directThreadId]);
    const onThreadChangeRef = useRef(onThreadChange);
    // After the open chat is marked read: refresh the chat list's unread dots and the nav badge.
    const onReadRef = useRef<(() => void) | null>(null);
    useEffect(() => { onThreadChangeRef.current = onThreadChange; });
    const [isLoading, setIsLoading] = useState(true);
    const [isSending, setIsSending] = useState(false);
    const [sendMode, setSendMode] = useState<"queue" | "replace">("queue");
    const [controlError, setControlError] = useState<string | null>(null);
    const [showCancelledHistory, setShowCancelledHistory] = useState(false);
    const [isTyping, setIsTyping] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [hasOlderMessages, setHasOlderMessages] = useState(false);
    const [isLoadingOlder, setIsLoadingOlder] = useState(false);
    const [isAtBottom, setIsAtBottom] = useState(true);
    const [unreadCount, setUnreadCount] = useState(0);
    const [recordingSecs, setRecordingSecs] = useState(0);
    const audioBlobRef = useRef<Blob | null>(null);
    const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
    const [micError, setMicError] = useState<string | null>(null);
    const [pendingAttachments, setPendingAttachments] = useState<AttachmentRef[]>([]);
    const [attachError, setAttachError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const formRef = useRef<HTMLFormElement>(null);
    // A chat that just opened puts the caret in its composer, so typing starts there.
    // Desktop pointers only: on a phone that would raise the keyboard over the new chat.
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const focusComposer = useCallback(() => {
        if (typeof window === "undefined" || !window.matchMedia("(pointer: fine)").matches) return;
        requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
    }, []);
    const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const recordingChunksRef = useRef<Blob[]>([]);
    const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const lastSeenAtRef = useRef<string | null>(null);
    const preserveScrollHeightRef = useRef<number | null>(null);
    const forceScrollToBottomRef = useRef(true);
    const isAtBottomRef = useRef(true);

    const rowVirtualizer = useVirtualizer({
        count: messages.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 88,
        overscan: 8,
        getItemKey: (index) => messages[index].id,
    });
    // Let the virtualizer compensate for rows resizing ABOVE the reading point.
    // Disable the browser's second anchoring mechanism on the scroll container.
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
        !isAtBottomRef.current && item.start < (instance.scrollOffset ?? 0);
    const isLiveArrival = useLiveArrivals(messages);
    // A chat that just opened: its first page enters staggered (chat-enter.ts), so the
    // transcript does not land in one frame. Live arrivals keep their own entrance.
    const enterStepOf = useChatEnter(messages, chatViewKey(activeThreadId, newChatKey));


    const loadMessages = useCallback(async ({ since, before }: { since?: string | null; before?: string | null } = {}) => {
        // This load is for `activeThreadId` (null = the main chat). A stale copy of this
        // function (a delayed poll scheduled in another chat) must never fill this one.
        const view = chatViewKey(activeThreadId, null);
        if (viewKeyRef.current !== view) return;
        const params = new URLSearchParams({ targetAgentId: agentId });
        if (activeThreadId) params.set("directThreadId", activeThreadId);
        params.set("limit", String(CHAT_PAGE_SIZE));
        if (since) params.set("since", since);
        if (before) params.set("before", before);
        const eventsSince = before ? null : eventsSinceParam(liveRunsRef.current);
        if (eventsSince) params.set("eventsSince", eventsSince);

        const generation = viewGenerationRef.current;
        const res = await fetch(`/api/chat?${params.toString()}`);
        if (generation !== viewGenerationRef.current || viewKeyRef.current !== view) return;
        if (!res.ok) {
            // One of the person's own chats that is gone (a stale link or remembered id): open the main
            // chat. Only where the page treats this as their own chats (onThreadChange); the agent's
            // Operations thread and other secondary threads keep showing the error.
            if (res.status === 404 && activeThreadId && !before && onThreadChangeRef.current) {
                viewKeyRef.current = chatViewKey(null, null);
                setActiveThreadId(null);
                onThreadChangeRef.current(null);
                return;
            }
            throw new Error("Failed to load direct thread");
        }

        const data = await res.json() as {
            thread?: DirectThread;
            messages?: DirectMessage[];
            participants?: DirectParticipant[];
            hasMore?: boolean;
            liveRuns?: RunLive[];
            replyRuns?: Record<string, ReplyRun>;
            runtime?: ChatRuntime;
        };
        if (generation !== viewGenerationRef.current || viewKeyRef.current !== view) return;
        if (data.runtime) setRuntime(data.runtime);

        if (!before) {
            const merged = mergeLiveRuns(liveRunsRef.current, data.liveRuns, Date.now());
            liveRunsRef.current = merged;
            setLiveRuns(merged);
        }
        if (data.replyRuns && Object.keys(data.replyRuns).length > 0) {
            const incoming = data.replyRuns;
            setReplyRuns((prev) => {
                const changed = Object.entries(incoming).some(([id, run]) => JSON.stringify(prev[id]) !== JSON.stringify(run));
                return changed ? { ...prev, ...incoming } : prev;
            });
        }

        if (data.thread) {
            setThread(data.thread);
        }

        if (data.participants) {
            setParticipants(data.participants);
        }

        if (data.messages && data.messages.length > 0) {
            const nextMessages = data.messages;
            setMessages((prev) => {
                if (before) {
                    const existingIds = new Set(prev.map((message) => message.id));
                    const prepended = nextMessages.filter((message) => !existingIds.has(message.id));
                    return prepended.length > 0 ? [...prepended, ...prev] : prev;
                }
                if (!since && prev.length === 0) return nextMessages;
                const existingIds = new Set(prev.map((message) => message.id));
                const updates = new Map(nextMessages.map(message => [message.id, message]));
                const refreshed = prev.map(message => {
                    const update = updates.get(message.id);
                    return update && JSON.stringify(update) !== JSON.stringify(message) ? update : message;
                });
                const appended = nextMessages.filter((message) => !existingIds.has(message.id));
                // Agent replies arriving after the first load type themselves in (never history).
                if (prev.length > 0) markLiveReveal(appended);
                if (appended.length > 0 && !isAtBottomRef.current && since) {
                    setUnreadCount((count) => count + appended.length);
                }
                return appended.length === 0 && refreshed.every((message, index) => message === prev[index])
                    ? prev : [...refreshed, ...appended];
            });

            if (!before) {
                lastSeenAtRef.current = nextMessages[nextMessages.length - 1].createdAt;
            }
        }

        const threadId = data.thread?.id;
        const shouldMarkRead = threadId && !before && (
            !since || data.messages?.some((message) => message.senderType === "agent")
        );
        if (shouldMarkRead) {
            void fetch("/api/chat/status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ threadId, markRead: true }),
            }).then(() => onReadRef.current?.()).catch(() => {});
        }

        if (!since) {
            setHasOlderMessages(Boolean(data.hasMore));
        }
    }, [agentId, activeThreadId]);

    const loadOlderMessages = useCallback(async () => {
        if (isLoadingOlder || !hasOlderMessages || messages.length === 0) return;

        preserveScrollHeightRef.current = scrollRef.current?.scrollHeight ?? null;
        setIsLoadingOlder(true);
        try {
            await loadMessages({ before: messages[0].createdAt });
        } catch (error) {
            console.error("Failed to load older direct messages", error);
        } finally {
            setIsLoadingOlder(false);
        }
    }, [hasOlderMessages, isLoadingOlder, loadMessages, messages]);

    const handleTyping = (text: string) => {
        setDraft(text);
        if (draftKey) writeThreadDraft(draftKey, text);

        if (!isTyping && text.trim().length > 0) {
            setIsTyping(true);
            if (thread?.id) {
                void fetch("/api/chat/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ threadId: thread.id, typing: true }),
                });
            }
        }

        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

        typingTimeoutRef.current = setTimeout(() => {
            setIsTyping(false);
            if (thread?.id) {
                void fetch("/api/chat/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ threadId: thread.id, typing: false }),
                });
            }
        }, 3000);
    };

    // Adaptive poll (§4.7): 1.5 s while a run is live, 3 s otherwise, a slow
    // fallback while the realtime socket is up (an invalidation of this thread
    // refetches at once), and none while the tab is hidden (it resumes at once
    // when shown again). Restarts, with a fresh initialize, when the thread changes.
    useLivePoll((run) => loadMessages().catch((error) => {
        if (run.active) {
            console.error("Failed to poll direct chat", error);
        }
    }), {
        fastMs: () => chatPollDelayMs("direct", liveRunsRef.current.some((liveRun) => liveRun.status === "running")),
        topics: thread?.id ? [`thread:${thread.id}`] : [],
        resetKey: loadMessages,
        // A New chat composer has nothing to load until its first message creates the chat.
        enabled: newChatKey === null,
        first: async (run) => {
            const keep = keepMessagesRef.current;
            keepMessagesRef.current = false;
            if (!keep) {
                setIsLoading(true);
                resetChatView();
            }

            try {
                await loadMessages();
            } catch (error) {
                if (run.active) {
                    console.error("Failed to initialize direct chat", error);
                }
            } finally {
                if (run.active) {
                    setIsLoading(false);
                }
            }
        },
    });

    function clearScheduledPolls() {
        for (const timer of pollTimersRef.current) clearTimeout(timer);
        pollTimersRef.current.clear();
    }

    /** A poll a little after a send, dropped on a chat switch (and by loadMessages' own chat check). */
    function schedulePoll(run: () => void, delay: number) {
        const timer = setTimeout(() => {
            pollTimersRef.current.delete(timer);
            run();
        }, delay);
        pollTimersRef.current.add(timer);
    }

    /** A recording, a voice preview or an upload error belongs to the chat it was made in. */
    function clearComposerMedia() {
        const recorder = mediaRecorderRef.current;
        if (recorder && recorder.state !== "inactive") {
            // Stop without turning the clip into a preview in the next chat.
            recorder.onstop = () => recorder.stream.getTracks().forEach((track) => track.stop());
            recorder.stop();
        }
        mediaRecorderRef.current = null;
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        setIsRecording(false);
        setRecordingSecs(0);
        audioBlobRef.current = null;
        setAudioPreviewUrl((url) => {
            if (url) URL.revokeObjectURL(url);
            return null;
        });
        setMicError(null);
        setAttachError(null);
    }

    function resetChatView() {
        viewGenerationRef.current += 1;
        clearScheduledPolls();
        setMessages([]);
        setThread(null);
        setParticipants([]);
        liveRunsRef.current = [];
        setLiveRuns([]);
        setReplyRuns({});
        setHasOlderMessages(false);
        setShowCancelledHistory(false);
        setControlError(null);
        lastSeenAtRef.current = null;
        forceScrollToBottomRef.current = true;
        isAtBottomRef.current = true;
        setIsAtBottom(true);
        setUnreadCount(0);
    }

    // The agent's running runs elsewhere, for t("alsoWorkingOn") and the busy
    // queue signal. Refetches on `agents` and this thread's invalidations.
    useLivePoll(async (poll) => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        try {
            const response = await fetch(`/api/agents/${agentId}/running`, { cache: "no-store" });
            if (!response.ok || !poll.active) return;
            const data = await response.json() as { runs?: RunningRun[] };
            if (poll.active) setRunningRuns(Array.isArray(data.runs) ? data.runs : []);
        } catch {
            // Transient failure: keep the last snapshot.
        }
    }, { fastMs: 5000, topics: thread?.id ? ["agents", `thread:${thread.id}`] : ["agents"] });

    useEffect(() => () => {
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    }, [loadMessages]);
    useEffect(() => {
        const timers = pollTimersRef.current;
        return () => {
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
        };
    }, []);

    // ---- Several chats with this agent (private mode) ----
    // Shown for the viewer's own chats only, never in the agent's shared/Operations thread.
    // Sticky while the next chat loads (thread is briefly null), so the bar does not flicker on a switch.
    const [ownChatSeen, setOwnChatSeen] = useState(false);
    useEffect(() => {
        if (thread?.ownerUserId) setOwnChatSeen(true);
    }, [thread?.ownerUserId]);
    const isOwnChat = newChatKey !== null || Boolean(thread?.ownerUserId) || (ownChatSeen && !thread);
    const chats = useAgentChats(agentId, isOwnChat);
    const isArchived = Boolean(thread?.archivedAt);
    // Tell the page when the person's own chat on screen is (or stops being) archived, so it is
    // not remembered as the chat to reopen (an archived chat would not be found next time).
    const reportedArchivedRef = useRef<{ id: string; archived: boolean } | null>(null);
    useEffect(() => {
        if (!thread?.id || !thread.ownerUserId) return;
        const previous = reportedArchivedRef.current;
        reportedArchivedRef.current = { id: thread.id, archived: isArchived };
        const wasArchived = previous?.id === thread.id && previous.archived;
        if (isArchived !== wasArchived) onThreadChangeRef.current?.(thread.id, { archived: isArchived });
    }, [thread?.id, thread?.ownerUserId, isArchived]);
    const canStartNewChat = canSend && chats.multiChatEnabled;
    const showChatBar = chats.available && isOwnChat
        && (chats.multiChatEnabled || chats.chats.length > 1 || isArchived || newChatKey !== null);
    useEffect(() => {
        onReadRef.current = () => {
            chats.reload();
            void refreshNavBadges();
        };
    });
    const unreadTotal = chats.chats.reduce((sum, chat) => sum + chat.unread, 0);
    useEffect(() => {
        if (chats.available) onUnreadTotal?.(unreadTotal);
    }, [chats.available, unreadTotal, onUnreadTotal]);

    // Drafts are kept per chat (sessionStorage): `new:<agent>` for a New chat composer,
    // else the chat's id once known. The main chat's id arrives with its first load,
    // so a draft typed (or handed over) before that moves along to it.
    const draftKey = newChatKey ? `new:${agentId}` : activeThreadId ?? thread?.id ?? null;
    const previousDraftKeyRef = useRef<string | null>(null);
    useEffect(() => {
        const previous = previousDraftKeyRef.current;
        previousDraftKeyRef.current = draftKey;
        if (!draftKey || draftKey === previous) return;
        const stored = readThreadDraft(draftKey);
        const handed = handedDraftRef.current;
        handedDraftRef.current = null;
        if (previous === null && handed) {
            // A draft handed over from another page wins over one stored for the main chat.
            writeThreadDraft(draftKey, handed);
            setDraft(handed);
            return;
        }
        if (previous === null) {
            // The same chat resolving its id: keep what is typed unless a draft was stored for it.
            setDraft((current) => {
                if (stored) return stored;
                if (current) writeThreadDraft(draftKey, current);
                return current;
            });
            return;
        }
        setDraft(stored);
    }, [draftKey]);

    /** Where a message goes: the New chat being started, or the chat on screen. */
    const chatTarget = () => newChatKey
        ? { newChat: { clientKey: newChatKey } }
        : { directThreadId: activeThreadId ?? thread?.id ?? null };

    /**
     * After a send from a New chat composer (`sent`: the composer's client key and
     * view when the send started): the chat now exists. Still on that composer:
     * show the chat in place (keeping the message on screen) and tell the page.
     * Switched away meanwhile: only refresh the chat list. Returns false for an
     * ordinary send. A retried key answers with the chat it already made; a
     * different text sent then goes back into the composer, with a notice.
     */
    const afterNewChat = (
        data: { thread?: DirectThread; message?: DirectMessage; created?: boolean },
        text: string | null,
        sent: { clientKey: string | null; view: string },
    ) => {
        if (!sent.clientKey || !data.thread) return false;
        const created = data.thread;
        writePendingNewChatKey(agentId, null);
        writeThreadDraft(`new:${agentId}`, "");
        const notSent = data.created === false && text && data.message && data.message.text !== text ? text : null;
        if (notSent) writeThreadDraft(created.id, notSent);
        if (viewKeyRef.current !== sent.view) {
            chats.reload();
            return true;
        }
        // Anything still in flight for the composer is for a view that no longer exists.
        viewGenerationRef.current += 1;
        clearScheduledPolls();
        viewKeyRef.current = chatViewKey(created.id, null);
        keepMessagesRef.current = true;
        setThread(created);
        if (data.message) {
            const message = data.message;
            setMessages([message]);
            lastSeenAtRef.current = message.createdAt;
        }
        previousDraftKeyRef.current = created.id;
        setNewChatKey(null);
        setActiveThreadId(created.id);
        setIsLoading(false);
        focusComposer();
        if (notSent) {
            setDraft(notSent);
            setControlError(tChats("alreadyStarted"));
        }
        onThreadChangeRef.current?.(created.id);
        chats.reload();
        return true;
    };

    /** Refusals that change what the chat shows: the cap dialog, or an archived chat. */
    const handleChatRefusal = (error: unknown) => {
        if (!(error instanceof ChatSendError)) return false;
        if (error.code === "chat_limit_reached") {
            const limit = Number(error.extra.limit) || chats.limit;
            const open = Number(error.extra.open) || chats.open;
            setLimitReached({ limit, open });
            chats.reload();
            return true;
        }
        if (error.code === "chat_archived") {
            setControlError(tChats("errors.archived"));
            void loadMessages().catch(() => {});
            return true;
        }
        if (error.code === "multi_chat_disabled" || error.code === "rate_limited") {
            setControlError(chatErrorMessage({ code: error.code, error: error.message }));
            chats.reload();
            return true;
        }
        return false;
    };

    const selectChat = (threadId: string) => {
        if (!newChatKey && threadId === (activeThreadId ?? thread?.id)) return;
        viewKeyRef.current = chatViewKey(threadId, null);
        clearScheduledPolls();
        clearComposerMedia();
        setNewChatKey(null);
        setSendMode("queue");
        setPendingAttachments([]);
        setActiveThreadId(threadId);
        onThreadChangeRef.current?.(threadId);
    };

    const startNewChat = () => {
        if (!canStartNewChat || newChatKey) return;
        // Kept until the first message lands, so a retried or double send makes one chat.
        const key = readPendingNewChatKey(agentId) ?? newChatClientKey();
        writePendingNewChatKey(agentId, key);
        viewKeyRef.current = chatViewKey(null, key);
        resetChatView();
        clearComposerMedia();
        setIsLoading(false);
        setSendMode("queue");
        setPendingAttachments([]);
        setNewChatKey(key);
        focusComposer();
    };

    const restoreChat = async () => {
        if (!thread?.id || restoring) return;
        setRestoring(true);
        setControlError(null);
        const result = await patchChat(thread.id, { archived: false });
        setRestoring(false);
        if (!result.ok) {
            if (result.code === "chat_limit_reached") setLimitReached({ limit: chats.limit, open: chats.open });
            else setControlError(chatErrorMessage(result));
            return;
        }
        chats.reload();
        void loadMessages().catch(() => {});
    };

    const lastScrolledMessageRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (scrollRef.current) {
            if (preserveScrollHeightRef.current !== null) {
                const previousHeight = preserveScrollHeightRef.current;
                preserveScrollHeightRef.current = null;
                scrollRef.current.scrollTop += scrollRef.current.scrollHeight - previousHeight;
                return;
            }
            const latestId = messages[messages.length - 1]?.id;
            const hasNewMessage = latestId !== lastScrolledMessageRef.current;
            lastScrolledMessageRef.current = latestId;
            if ((isAtBottomRef.current || forceScrollToBottomRef.current) && (hasNewMessage || forceScrollToBottomRef.current) && messages.length > 0) {
                rowVirtualizer.scrollToIndex(messages.length - 1, { align: "end", behavior: "auto" });
                forceScrollToBottomRef.current = false;
                setUnreadCount(0);
            }
        }
    }, [isAtBottom, messages, rowVirtualizer]);

    const handleScroll = () => {
        const element = scrollRef.current;
        if (!element) return;
        const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 48;
        isAtBottomRef.current = atBottom;
        setIsAtBottom(atBottom);
        if (atBottom) setUnreadCount(0);
    };

    const scrollToLatest = () => {
        forceScrollToBottomRef.current = true;
        isAtBottomRef.current = true;
        setIsAtBottom(true);
        setUnreadCount(0);
        if (messages.length > 0) {
            rowVirtualizer.scrollToIndex(messages.length - 1, { align: "end", behavior: "smooth" });
        }
    };



    const startRecording = async () => {
        setMicError(null);

        // getUserMedia requires a secure context (HTTPS or localhost)
        if (!window.isSecureContext) {
            setMicError(t("mic.insecure"));
            return;
        }

        if (!navigator.mediaDevices?.getUserMedia) {
            setMicError(t("mic.unavailable"));
            return;
        }

        try {
            // Call getUserMedia directly inside the user-gesture handler
            // so the browser shows its native permission prompt naturally.
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            setMicError(null);
            const mr = new MediaRecorder(stream);
            recordingChunksRef.current = [];
            mr.ondataavailable = (e) => { if (e.data.size > 0) recordingChunksRef.current.push(e.data); };
            mr.onstop = () => {
                // Use base MIME type (strip codec params) so the backend doesn't reject it
                const baseType = (mr.mimeType || "audio/webm").split(";")[0].trim();
                const blob = new Blob(recordingChunksRef.current, { type: baseType });
                audioBlobRef.current = blob;
                setAudioPreviewUrl(URL.createObjectURL(blob));
                stream.getTracks().forEach(t => t.stop());
            };
            mr.start();
            mediaRecorderRef.current = mr;
            setIsRecording(true);
            setRecordingSecs(0);
            recordingTimerRef.current = setInterval(() => setRecordingSecs(s => s + 1), 1000);
        } catch (err) {
            if (err instanceof Error && err.name === "NotAllowedError") {
                // NotAllowedError fires when:
                //   - The user denied the prompt
                //   - A Permissions-Policy header blocks microphone (e.g. microphone=())
                //   - The user has previously denied and the browser doesn't re-prompt
                setMicError(t("mic.denied"));
            } else if (err instanceof Error && err.name === "NotFoundError") {
                setMicError(t("mic.notFound"));
            } else if (err instanceof Error && err.name === "NotReadableError") {
                setMicError(t("mic.busy"));
            } else {
                setMicError(t("mic.startFailed"));
            }
        }
    };

    const stopRecording = () => {
        mediaRecorderRef.current?.stop();
        setIsRecording(false);
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };

    const discardVoice = () => {
        if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
        audioBlobRef.current = null;
        setAudioPreviewUrl(null);
        setRecordingSecs(0);
    };

    const sendVoice = async () => {
        if (!canSend || !audioBlobRef.current || isSending) return;
        setIsSending(true);
        setMicError(null);
        const sent = { clientKey: newChatKey, view: viewKeyRef.current };
        const target = chatTarget();
        try {
            const form = new FormData();
            form.append("file", audioBlobRef.current, `voice-${Date.now()}.webm`);
            const uploadRes = await fetch("/api/chat/voice", { method: "POST", body: form });
            if (!uploadRes.ok) {
                let errMsg = t("voiceUploadFailed");
                try { const body = await uploadRes.json(); if (body.error) errMsg = body.error; } catch {}
                throw new Error(errMsg);
            }
            const voiceArtifact = await uploadRes.json() as { id: string; name: string; contentType: string; sizeBytes: number };

            const secs = recordingSecs;
            const mins = Math.floor(secs / 60);
            const durationLabel = mins > 0 ? `${mins}:${String(secs % 60).padStart(2, "0")}` : `${secs}s`;
            const text = `Voice message (${durationLabel})`;

            // Sent as a real attachment (same path as file uploads) so the
            // agent can find and download it via the artifact id — a raw URL
            // embedded in the text isn't resolvable by the agent's own auth.
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, targetAgentId: agentId, ...target, attachments: [voiceArtifact.id] }),
            });
            if (!res.ok) await throwSendError(res, t("sendFailed"));
            const data = await res.json() as { thread?: DirectThread; message?: DirectMessage; created?: boolean };
            const stillHere = viewKeyRef.current === sent.view;
            if (afterNewChat(data, null, sent)) {
                if (stillHere) discardVoice();
                return;
            }
            // Sent from a chat that is no longer on screen: it is stored there; nothing to show here.
            if (!stillHere) return;
            if (data.thread) setThread(data.thread);
            if (data.message) {
                setMessages(prev => prev.some(m => m.id === data.message!.id) ? prev : [...prev, data.message!]);
                lastSeenAtRef.current = data.message.createdAt;
                // Immediately poll for agent response
                const since = data.message.createdAt;
                schedulePoll(() => void loadMessages({ since }).catch(() => {}), 1500);
                schedulePoll(() => void loadMessages({ since: lastSeenAtRef.current }).catch(() => {}), 4000);
            }
            discardVoice();
        } catch (err) {
            // A failure for a chat that is no longer on screen: its clip went with that chat.
            if (viewKeyRef.current !== sent.view) return;
            if (handleChatRefusal(err)) return;
            const message = err instanceof Error ? err.message : t("unknownError");
            console.error("Failed to send voice message", err);
            setMicError(message);
        } finally {
            setIsSending(false);
        }
    };


    const handleAttachFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        event.target.value = "";
        if (files.length === 0) return;
        setAttachError(null);
        for (const file of files) {
            try {
                const form = new FormData();
                form.append("file", file);
                const uploadRes = await fetch("/api/chat/attachments", { method: "POST", body: form });
                if (!uploadRes.ok) {
                    let errMsg = t("uploadFailed");
                    try { const body = await uploadRes.json(); if (body.error) errMsg = body.error; } catch {}
                    setAttachError(errMsg);
                    continue;
                }
                const data = await uploadRes.json() as { id: string; name: string; contentType: string; sizeBytes: number };
                setPendingAttachments((prev) => [...prev, { id: data.id, name: data.name, contentType: data.contentType, sizeBytes: data.sizeBytes }]);
            } catch {
                setAttachError(t("uploadFailed"));
            }
        }
    };

    const removePendingAttachment = (id: string) => {
        setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
    };

    // In a person's own chat Stop stops that chat; an older runtime can only stop all of the
    // agent's chats (runtime.stopScope "agent"), so it asks first. `everywhere`: Stop all chats.
    const stopNeedsConfirm = runtime?.stopScope === "agent" && Boolean(thread?.ownerUserId);
    const requestStop = () => {
        if (stopNeedsConfirm) setConfirmStop("chat");
        else void stopAgent();
    };
    const stopAgent = async (everywhere = false) => {
        if (isSending) return;
        setConfirmStop(null);
        setIsSending(true);
        setControlError(null);
        try {
            const res = await fetch(`/api/agents/${agentId}/control`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(everywhere ? { action: "kill", scope: "agent" } : { action: "kill", directThreadId: activeThreadId ?? thread?.id ?? null }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || t("stopFailed"));
            await loadMessages();
        } catch (e) { setControlError(e instanceof Error ? e.message : t("stopFailed")); }
        finally { setIsSending(false); }
    };

    const updateQueueItem = async (messageId: string, action: "cancel" | "retry") => {
        if (isSending) return;
        setIsSending(true);
        setControlError(null);
        try {
            const res = await fetch(`/api/chat/messages/${messageId}`, { method: action === "cancel" ? "DELETE" : "POST" });
            const data = await res.json() as { error?: string; message?: DirectMessage };
            if (!res.ok || !data.message) throw new Error(data.error || t("queueUpdateFailed"));
            setMessages((previous) => previous.map((message) => message.id === data.message!.id ? data.message! : message));
            if (action === "cancel") setShowCancelledHistory(true);
            void loadMessages().catch(() => {});
        } catch (error) {
            setControlError(error instanceof Error ? error.message : t("queueUpdateFailed"));
        } finally {
            setIsSending(false);
        }
    };

    const handleSend = async (event: React.FormEvent) => {
        event.preventDefault();
        const text = draft.trim();
        if (!canSend || (!text && pendingAttachments.length === 0) || isSending) return;

        setIsSending(true);
        setControlError(null);
        setDraft("");
        // The chat this text was typed in: a failure puts it back there, even after a switch.
        const sentDraftKey = draftKey;
        const sent = { clientKey: newChatKey, view: viewKeyRef.current };
        if (sentDraftKey) writeThreadDraft(sentDraftKey, "");
        forceScrollToBottomRef.current = true;
        isAtBottomRef.current = true;
        setIsAtBottom(true);

        try {
            const replacing = sendMode === "replace" && !newChatKey && !text.trim().startsWith("/");
            if (replacing && pendingAttachments.length) throw new Error(t("attachmentsQueued"));
            const res = await fetch(replacing ? `/api/agents/${agentId}/control` : "/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(replacing ? { action: "replace", prompt: text, directThreadId: activeThreadId ?? thread?.id ?? null } : { text, targetAgentId: agentId, ...chatTarget(), attachments: pendingAttachments.map((a) => a.id) }),
            });

            if (!res.ok) await throwSendError(res, t("sendDirectFailed"));

            const data = await res.json() as { thread?: DirectThread; message?: DirectMessage; deduplicated?: boolean; created?: boolean };
            const stillHere = viewKeyRef.current === sent.view;
            if (afterNewChat(data, text, sent)) {
                if (stillHere) setPendingAttachments([]);
                return;
            }
            // Sent from a chat that is no longer on screen: it is stored there; nothing to show here.
            if (!stillHere) return;
            if (data.thread) {
                setThread(data.thread);
            }
            if (data.message) {
                setMessages((prev) => prev.some((message) => message.id === data.message!.id) ? prev : [...prev, data.message!]);
                lastSeenAtRef.current = data.message.createdAt;
                setPendingAttachments([]);
                setSendMode("queue");
                void loadMessages().catch(() => {});
                // Aggressive polling after send: catch agent response fast (dropped on a chat switch).
                const pollAfter = (delay: number, useSince: boolean) => schedulePoll(
                    () => void loadMessages(useSince ? { since: lastSeenAtRef.current } : {}).catch(() => {}), delay);
                pollAfter(2000, true);   // 2s: poll with since
                pollAfter(5000, true);   // 5s: poll with since
                pollAfter(8000, false);  // 8s: FULL reload (no since) — catch anything missed
            }
            if (data.deduplicated) {
                setControlError(t("duplicate"));
            }
        } catch (error) {
            if (sentDraftKey) writeThreadDraft(sentDraftKey, text);
            // Switched to another chat meanwhile: the text waits in its own chat's draft.
            if (viewKeyRef.current !== sent.view) return;
            setDraft(text);
            if (handleChatRefusal(error)) return;
            console.error(t("sendDirectFailed"), error);
            setControlError(error instanceof Error ? error.message : t("sendFailed"));
        } finally {
            setIsSending(false);
        }
    };

    const typingAgent = participants.find(p =>
        p.participantType === 'agent' &&
        p.typingUntil &&
        new Date(p.typingUntil).getTime() > Date.now()
    );
    const isAgentTyping = Boolean(typingAgent);
    const agentActivity = typingAgent?.currentActivity?.trim() || null;

    const agentLastReadAt = participants.find(p => p.participantType === 'agent')?.lastReadAt;

    // Interactive widgets in agent replies can send a follow-up prompt as the
    // operator (a "Show details" button, a drill-down in a chart). It is posted
    // exactly like a typed message, so it stays visible in the transcript.
    const sendWidgetPrompt = useCallback(async (prompt: string) => {
        if (!canSend) return;
        setControlError(null);
        forceScrollToBottomRef.current = true;
        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: prompt, targetAgentId: agentId, directThreadId: activeThreadId ?? thread?.id ?? null, attachments: [] }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || t("sendFailed"));
            }
            const data = await res.json() as { thread?: DirectThread; message?: DirectMessage };
            if (data.thread) setThread(data.thread);
            if (data.message) {
                setMessages((prev) => prev.some((m) => m.id === data.message!.id) ? prev : [...prev, data.message!]);
                lastSeenAtRef.current = data.message.createdAt;
            }
            void loadMessages().catch(() => {});
            return true;
        } catch (error) {
            setControlError(error instanceof Error ? error.message : t("sendFailed"));
            return false;
        }
    }, [agentId, activeThreadId, thread?.id, loadMessages, canSend, t]);
    const richActions = useMemo(() => canSend ? { sendPrompt: sendWidgetPrompt } : {}, [sendWidgetPrompt, canSend]);
    const queueItems = useMemo(() => messages.filter((message) => (
        message.senderType === "human" && ["queued", "seen", "acting"].includes(message.deliveryState || "")
    )), [messages]);
    const activeQueueItem = queueItems.find((message) => message.deliveryState === "acting");
    const waitingQueueItems = queueItems.filter((message) => message.id !== activeQueueItem?.id);
    // A single active turn is already represented in the transcript and typing
    // indicator. The separate panel is useful only when it explains a backlog.
    const hasQueueBacklog = queueItems.length >= 2;
    // The agent's running run from real events (bridge 0.9+), when any.
    const liveRun = runningRun(liveRuns, agentId);
    // The live row covers the whole turn, not just the bridge's typing window.
    const liveActive = isAgentTyping || Boolean(activeQueueItem) || Boolean(liveRun);
    const recentlyCancelledItems = useMemo(() => messages
        .filter((message) => message.senderType === "human" && message.deliveryState === "cancelled")
        .slice(-3).reverse(), [messages]);
    // A message the runtime gave up on is stored as cancelled too; say "failed" for those.
    const recentlyStoppedLabel = t(`stopped.${stoppedKind(recentlyCancelledItems)}`);

    // "Also working on <task/chat> · 23 min →" for the agent's runs in other
    // threads, plus a "Queued — busy" signal when this chat's last message has
    // no run yet while the agent is already at (or over) its parallel-turn cap.
    const alsoWorking = useMemo(() => summarizeAlsoWorking(runningRuns, thread?.id ?? null), [runningRuns, thread?.id]);
    const lastMessage = messages[messages.length - 1];
    const lastMessageQueued = lastMessage?.senderType === "human" && (lastMessage.deliveryState === "queued" || lastMessage.deliveryState === "seen");
    // Honest queue state: the runtime's real parallel limit (unknown = 1), counting only its work elsewhere.
    const queuedBusy = queuedBusyState({
        lastMessageQueued: Boolean(lastMessageQueued),
        runningThreadIds: runningRuns.map((run) => run.threadId),
        currentThreadId: thread?.id ?? null,
        maxParallelTurns: runtime?.maxParallelTurns ?? null,
        // "Working in N other chats" counts only this person's other chats with the agent.
        ownChatIds: chats.chats.map((chat) => chat.id),
    });
    // The "also working on" run, when it is in one of the viewer's own chats with this agent: open it in place.
    const alsoWorkingRun = alsoWorking.primary ? runningRuns.find((run) => run.runId === alsoWorking.primary!.runId) : undefined;
    const alsoWorkingChat = alsoWorkingRun?.threadId ? chats.chats.find((chat) => chat.id === alsoWorkingRun.threadId) ?? null : null;

    return (
        <RichMessageActionsContext.Provider value={richActions}>
        <div className={cn("relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card", hideHeader && "bg-transparent border-none rounded-none shadow-none")}>
            {!hideHeader && (
                <div className="flex items-center justify-between gap-4 p-5 border-b border-zinc-800 bg-zinc-900/40">
                    <div>
                        <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                                <IconRobot className="w-4 h-4 text-emerald-400" />
                            </div>
                            <div>
                                <h2 className="text-lg font-medium text-zinc-100">{t("title")}</h2>
                                <p className="text-xs text-zinc-500">
                                    {t("headerDescription", { name: agentName })}
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        {showStopAll && runtime?.canStopAll && (
                            <button
                                type="button"
                                onClick={() => setConfirmStop("all")}
                                disabled={isSending}
                                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-red-500/25 px-3 text-xs font-medium text-red-200 transition-colors hover:border-red-400/50 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                            >
                                <IconPlayerStop aria-hidden className="h-4 w-4" />
                                {tChats("stopAll")}
                            </button>
                        )}
                        <div className="text-right">
                            <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500">{t("thread")}</div>
                            <div className="text-xs font-mono text-zinc-400">{thread?.id || t("provisioning")}</div>
                        </div>
                    </div>
                </div>
            )}
            {hideHeader && showStopAll && runtime?.canStopAll && (
                <div className="flex justify-end border-b border-zinc-800/80 px-3 py-1.5">
                    <button type="button" onClick={() => setConfirmStop("all")} disabled={isSending}
                        className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-medium text-red-200 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                        <IconPlayerStop aria-hidden className="h-4 w-4" />
                        {tChats("stopAll")}
                    </button>
                </div>
            )}
            {showChatBar && (
                <DirectChatBar
                    agentId={agentId}
                    agentName={agentName}
                    chats={chats}
                    currentThreadId={newChatKey ? null : thread?.id ?? activeThreadId}
                    currentIsArchived={isArchived}
                    currentThread={thread?.ownerUserId ? { isMain: Boolean(thread.isMain), title: thread.title ?? null } : null}
                    newChatActive={newChatKey !== null}
                    canStartNew={canStartNewChat}
                    onSelect={selectChat}
                    onNewChat={startNewChat}
                    onChanged={(changedId) => {
                        if (changedId === thread?.id) void loadMessages().catch(() => {});
                    }}
                />
            )}

            <div ref={scrollRef} onScroll={handleScroll} style={{ overflowAnchor: "none" }} className="fade-y relative flex-1 overflow-y-auto p-3 sm:p-5">
                {isLoading ? (
                    <div className="h-full flex items-center justify-center text-sm text-zinc-500 animate-pulse">
                        {t("loading")}
                    </div>
                ) : messages.length === 0 ? (
                    // A chat that just opened (New chat, or an empty earlier one) rises in instead of
                    // landing settled: opacity and 6 px, no height, so the panel keeps its final frame.
                    <FadeRise key={chatViewKey(activeThreadId, newChatKey)} className="h-full">
                    <div className="h-full flex items-center justify-center">
                        <div className="max-w-sm rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/50 p-6 text-center">
                            <div className="text-sm text-zinc-300 mb-2">{newChatKey ? tChats("newChatEmptyTitle", { name: agentName }) : t("emptyTitle")}</div>
                            <div className="text-xs text-zinc-500 leading-relaxed">
                                {newChatKey ? tChats("newChatEmptyBody", { name: agentName }) : t("emptyBody")}
                            </div>
                        </div>
                    </div>
                    </FadeRise>
                ) : (
                    <div>
                        {hasOlderMessages && (
                            <div className="mb-4 flex justify-center">
                                <button
                                    type="button"
                                    onClick={loadOlderMessages}
                                    disabled={isLoadingOlder}
                                    className="rounded-full border border-zinc-800 bg-zinc-950/80 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-emerald-500/40 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {isLoadingOlder ? t("loadingOlder") : t("loadOlder")}
                                </button>
                            </div>
                        )}
                        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                            const i = virtualRow.index;
                            const message = messages[i];
                            const isHuman = message.senderType === "human";
                            const isControl = message.senderType === "system" && Boolean((message.metadataJson as Record<string, unknown> | null)?.runtimeControl);
                            const approvalCardId = approvalCardIdOf(message);
                            // System messages say who they are from: a request names its
                            // source platform; anything else comes from Emperor itself.
                            const senderLabel = message.senderType === "system" ? (requestSourceLabel(message.metadataJson) ? render(requestSourceCopy(message.metadataJson), requestSourceLabel(message.metadataJson)!) : "Emperor") : agentName;
                            const isRead = isHuman && agentLastReadAt && new Date(agentLastReadAt).getTime() >= new Date(message.createdAt).getTime();
                            const prev = messages[i - 1] ?? null;
                            const next = messages[i + 1] ?? null;

                            const showDaySep = !prev || !isSameDay(prev.createdAt, message.createdAt);
                            const isContinuation = !!prev && isGroupContinuation(message, prev);
                            const isLastInGroup = !next || !isGroupContinuation(next, message);
                            const messageAttachments = getMessageAttachments(message);
                            const isOwn = isHuman && message.senderId === currentUserId;
                            const isRich = !isHuman && hasRichBlocks(message.text);
                            // Its step in a freshly opened chat's entrance (0 = first row), or undefined.
                            const enterStep = enterStepOf(message.id);

                            return (
                                <div
                                    key={message.id}
                                    ref={rowVirtualizer.measureElement}
                                    data-index={i}
                                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
                                >
                                    {showDaySep && (
                                        <div className="flex items-center gap-2 my-4">
                                            <div className="flex-1 border-t border-zinc-800" />
                                            <span className="text-[10px] uppercase tracking-widest text-zinc-600">{dateSeparatorLabel(message.createdAt)}</span>
                                            <div className="flex-1 border-t border-zinc-800" />
                                        </div>
                                    )}

                                    <div className={cn(
                                        `flex ${isHuman ? "justify-end" : "justify-start"}`,
                                        isContinuation ? "mt-0.5" : "mt-3"
                                    )}>
                                        <div className={cn("flex min-w-0 max-w-[88%] flex-col sm:max-w-[80%]", isHuman ? "items-end" : "items-start", isRich && "w-full max-w-full sm:max-w-[min(92%,880px)]")}>
                                            {/* Sender label on group-start only; your own messages need none (the side says it). */}
                                            {!isContinuation && !isOwn && (
                                                <span className={cn("mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground", isHuman ? "mr-1" : "ml-1")}>
                                                    {isHuman ? <IconUser className="h-3 w-3" aria-hidden /> : <IconRobot className="h-3 w-3" aria-hidden />}
                                                    {isHuman ? getMessageSenderName(message) || tTeam("member") : senderLabel}
                                                </span>
                                            )}

                                            <div className={cn(
                                                // Both chats: your bubble is a neutral raised surface, the agent's a quieter
                                                // outlined one; the tail corner sits on the speaker's side of the last bubble.
                                                "min-w-0 max-w-full rounded-2xl border px-4 py-3",
                                                (enterStep !== undefined || isLiveArrival(message.id)) && "ec-message-in",
                                                isRich && "w-full",
                                                isHuman
                                                    ? "border-transparent bg-secondary text-secondary-foreground"
                                                    : "border-border bg-background/60 text-foreground",
                                                isLastInGroup && isHuman && "rounded-br-md",
                                                isLastInGroup && !isHuman && "rounded-bl-md"
                                            )}
                                            style={enterStep !== undefined ? ({ "--ec-stagger": enterStep } as CSSProperties) : undefined}>
                                                {!isHuman && hasChoicesBlock(message.text) ? (
                                                    <RichMessageActionsContext.Provider value={{ sendPrompt: sendWidgetPrompt, laterReplies: laterHumanTexts(messages, i) }}>
                                                        <MessageContent text={message.text} isHuman={isHuman} />
                                                    </RichMessageActionsContext.Provider>
                                                ) : message.senderType === "agent" && !isRich ? (
                                                    <TypingReveal messageId={message.id} text={message.text}>
                                                        <MessageContent text={message.text} isHuman={isHuman} />
                                                    </TypingReveal>
                                                ) : (
                                                    <MessageContent text={message.text} isHuman={isHuman} />
                                                )}
                                                {isControl && <p className="mt-2 text-xs text-zinc-400">
                                                    {message.deliveryState === "resolved" ? t("runtimeConfirmed") : t("waitingHermes")}
                                                </p>}
                                                {approvalCardId && <ApprovalCard approvalId={approvalCardId} />}
                                                {messageAttachments.length > 0 && (
                                                    <div className="mt-2 flex flex-col gap-1.5">
                                                        {messageAttachments.map((att) => (
                                                            att.contentType.startsWith("audio/") ? (
                                                                <audio
                                                                    key={att.id}
                                                                    controls
                                                                    src={`/api/ui/artifacts/${att.id}/download?disposition=inline`}
                                                                    className="w-full max-w-[220px] h-8"
                                                                    style={{ accentColor: "var(--primary)" }}
                                                                />
                                                            ) : (
                                                                <AttachmentChip
                                                                    key={att.id}
                                                                    attachment={att}
                                                                    href={`/api/ui/artifacts/${att.id}/download`}
                                                                />
                                                            )
                                                        ))}
                                                    </div>
                                                )}
                                                {!isHuman && hasStoredReasoning(message) && (
                                                    <MessageReasoningDisclosure messageId={message.id} />
                                                )}
                                                {message.senderType === "agent" && replyRuns[message.id] && (
                                                    <ReplyRunFooter run={replyRuns[message.id]} />
                                                )}
                                                {/* One footer line: the delivery inspector, the delivery state (per
                                                    message while pending, so a batch of queued messages each show their
                                                    own real state, then the group-level Read/Sent receipt once resolved)
                                                    and the time. */}
                                                <div className="mt-1.5 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
                                                    {isPersistedUuid(message.id) && (message.senderType === "human" || message.senderType === "agent") && (
                                                        <span className="mr-auto shrink-0">
                                                            <DeliveryInspector messageId={message.id} />
                                                        </span>
                                                    )}
                                                    {isHuman && message.deliveryState && message.deliveryState !== "resolved" ? (
                                                        <span className="flex min-w-0 items-center gap-1">
                                                            <span aria-hidden className={cn(
                                                                "h-1.5 w-1.5 shrink-0 rounded-full",
                                                                message.deliveryState === "acting" ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/60"
                                                            )} />
                                                            <span className={cn(
                                                                "truncate font-medium",
                                                                message.deliveryState === "acting" ? "text-emerald-600 dark:text-emerald-400" : runtimeFailureOf(message) ? "text-rose-500 dark:text-rose-400" : ""
                                                            )} title={runtimeFailureOf(message)?.reason ?? undefined}>
                                                                <TextSwap id={message.deliveryState}>{message.deliveryState === "cancelled" ? (failureLabel(message) ?? t("cancelled")) : message.deliveryState === "acting" ? t("beingHandled") : t("queued")}</TextSwap>
                                                            </span>
                                                            <span aria-hidden>·</span>
                                                        </span>
                                                    ) : isHuman && isLastInGroup ? (
                                                        <span className="flex items-center gap-1">
                                                            <span className={cn("font-medium transition-colors", isRead && "text-emerald-600 dark:text-emerald-400")}>
                                                                <TextSwap id={isRead ? "read" : "sent"}>{isRead ? t("read") : t("sent")}</TextSwap>
                                                            </span>
                                                            <span aria-hidden>·</span>
                                                        </span>
                                                    ) : null}
                                                    <time dateTime={new Date(message.createdAt).toISOString()} className="shrink-0 whitespace-nowrap tabular-nums">
                                                        {format.dateTime(new Date(message.createdAt), { hour: "2-digit", minute: "2-digit" })}
                                                    </time>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        </div>
                        {/* One steady row for the whole turn: shown while the viewer's prompt
                            is being handled OR the runtime reports typing, so a late bridge
                            refresh no longer drops it back to a bare t("beingHandled") pill.
                            Always mounted so its live region is ready before work starts. */}
                        <LiveStatusRow
                            active={liveActive}
                            activityKey={activeQueueItem?.id ?? null}
                            activity={agentActivity}
                            label={agentName}
                            idleVerb={t("isWorking")}
                            fallbackText={t("working")}
                            variant="direct"
                            step={liveRun?.current.summary ?? null}
                            stepStartedAt={liveRun && isTimedStepKind(liveRun.current.kind) ? liveRun.currentStartedAt : null}
                            detail={liveRun ? render(lastReasoningCopy(liveRun), lastReasoningLine(liveRun) ?? "") || null : null}
                        />
                        <Presence show={Boolean(liveActive && liveRun)} snappy className="mt-1 max-w-[88%] pl-4 sm:max-w-[80%]">
                            {liveRun && <LiveRunSteps steps={liveRun.steps} usage={liveRun.usage} />}
                        </Presence>
                    </div>
                )}
            </div>

            <Presence show={unreadCount > 0 && !isAtBottom} snappy scale y={8} className="absolute bottom-24 left-1/2 z-10 -translate-x-1/2">
                <button
                    type="button"
                    onClick={scrollToLatest}
                    className="rounded-full border border-border bg-popover px-3 py-1.5 text-xs font-medium text-foreground shadow-(--shadow-pop) transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    {tTeam("jumpToLatest", { count: unreadCount })}
                </button>
            </Presence>

            {canSend && isArchived && (
                <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 bg-zinc-950/80 p-3 sm:p-4">
                    <IconArchive aria-hidden className="h-4 w-4 shrink-0 text-zinc-500" />
                    <p className="min-w-0 flex-1 text-xs text-zinc-400">
                        {tChats("archivedNotice", { reason: archiveReasonLabel(thread?.archiveReason) })}
                    </p>
                    <button type="button" onClick={() => void restoreChat()} disabled={restoring}
                        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 px-3 text-xs font-medium text-zinc-200 transition-colors hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                        <IconRestore aria-hidden className="h-4 w-4" />
                        {tChats("restore")}
                    </button>
                    {controlError && <p role="alert" className="w-full text-xs text-red-300">{controlError}</p>}
                </div>
            )}
            {canSend && !isArchived && <div className="space-y-2 border-t border-zinc-800 bg-zinc-950/80 p-2 sm:p-4">
                {alsoWorking.primary && (
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-400">
                        <span className="shrink-0">{t("alsoWorkingOn")}</span>
                        {alsoWorkingChat ? (
                            <button type="button" onClick={() => selectChat(alsoWorkingChat.id)} className="min-w-0 truncate text-left text-cyan-300 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                {chatLabel(alsoWorkingChat)}{alsoWorking.primary.startedAt && <> · <WorkElapsed startedAt={alsoWorking.primary.startedAt} /></>}
                            </button>
                        ) : alsoWorking.primary.href ? (
                            <Link href={alsoWorking.primary.href} className="min-w-0 truncate text-cyan-300 hover:text-cyan-200">
                                {alsoWorking.primary.text}{alsoWorking.primary.startedAt && <> · <WorkElapsed startedAt={alsoWorking.primary.startedAt} /></>}
                            </Link>
                        ) : (
                            <span className="min-w-0 truncate text-zinc-300">{alsoWorking.primary.text}{alsoWorking.primary.startedAt && <> · <WorkElapsed startedAt={alsoWorking.primary.startedAt} /></>}</span>
                        )}
                        <span className="shrink-0 text-zinc-500">→</span>
                        {alsoWorking.more > 0 && <span className="shrink-0 text-zinc-500">{t("more", { count: alsoWorking.more })}</span>}
                    </div>
                )}
                {queuedBusy.show && (
                    <p className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
                        {queuedBusy.others > 0
                            ? tChats("queuedOtherChats", { name: agentName, count: queuedBusy.others })
                            : tChats("queuedBusyElsewhere", { name: agentName })}
                    </p>
                )}
                {(hasQueueBacklog || showCancelledHistory) && (
                    <details key={showCancelledHistory ? "history" : "pending"} open={showCancelledHistory ? true : undefined} aria-label={t("queueLabel")} className="rounded-xl border border-zinc-800 bg-zinc-900/50 text-xs">
                        <summary className="min-h-11 cursor-pointer px-3 py-3 font-medium text-zinc-300">{t("queueSummary", { count: queueItems.length })}</summary>
                        <div className="max-h-48 overflow-y-auto px-3 pb-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="font-semibold text-zinc-200">{t("queueTitle")}</span>
                            <div className="flex items-center gap-3">
                                <span className="text-zinc-500">{t("pending", { count: queueItems.length })}</span>
                                {!hasQueueBacklog && (
                                    <button type="button" onClick={() => setShowCancelledHistory(false)} className="text-zinc-500 hover:text-zinc-200">
                                        {t("close")}
                                    </button>
                                )}
                            </div>
                        </div>
                        {hasQueueBacklog && activeQueueItem && (
                            <QueueItem
                                message={activeQueueItem}
                                stateLabel={t("handlingNow")}
                                disabled={isSending}
                                onCancel={() => void updateQueueItem(activeQueueItem.id, "cancel")}
                            />
                        )}
                        {hasQueueBacklog && waitingQueueItems.map((message, index) => (
                            <QueueItem
                                key={message.id}
                                message={message}
                                stateLabel={waitingQueueItems.length > 1 ? t("waitingOf", { n: index + 1, total: waitingQueueItems.length }) : t("waitingState")}
                                disabled={isSending}
                                onCancel={() => void updateQueueItem(message.id, "cancel")}
                            />
                        ))}
                        {showCancelledHistory && recentlyCancelledItems.length > 0 && (
                            <div className="mt-2 border-t border-zinc-800 pt-2">
                                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">{t("recently", { label: recentlyStoppedLabel })}</p>
                                {recentlyCancelledItems.map((message) => (
                                    <QueueItem
                                        key={message.id}
                                        message={message}
                                        stateLabel={failureLabel(message) ?? t("cancelled")}
                                        disabled={isSending}
                                        onRetry={() => void updateQueueItem(message.id, "retry")}
                                    />
                                ))}
                            </div>
                        )}
                        </div>
                    </details>
                )}
                {recentlyCancelledItems.length > 0 && !showCancelledHistory && (
                    <button type="button" onClick={() => setShowCancelledHistory(true)} className="px-1 text-[10px] text-zinc-600 hover:text-zinc-300">
                        {t("recentlyReview", { count: recentlyCancelledItems.length, label: recentlyStoppedLabel })}
                    </button>
                )}
                {controlError && <p role="alert" className="text-xs text-red-300">{controlError}</p>}
                {micError && (
                    <div className="flex items-start gap-2 rounded-lg bg-red-900/40 border border-red-700/40 px-3 py-2 text-xs text-red-300">
                        <IconMicrophone className="w-3.5 h-3.5 shrink-0 text-red-400 mt-0.5" />
                        <span>
                            {micError === "blocked"
                                ? t.rich("micBlocked", { strong: (chunks) => <strong>{chunks}</strong> })
                                : micError}
                        </span>
                    </div>
                )}
                {/* State: recording in progress */}
                {isRecording && (
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 flex-1">
                            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
                            <span className="text-sm font-medium text-zinc-300">{t("recording")}</span>
                            <span className="text-sm font-mono text-zinc-400">
                                {Math.floor(recordingSecs / 60)}:{String(recordingSecs % 60).padStart(2, "0")}
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={stopRecording}
                            className="inline-flex items-center gap-2 rounded-full bg-red-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-400 transition-colors"
                        >
                            <IconSquare className="w-3.5 h-3.5 fill-white" />
                            {t("stop")}
                        </button>
                    </div>
                )}

                {/* State: preview before sending */}
                {!isRecording && audioPreviewUrl && (
                    <div className="flex items-center gap-2">
                        <audio controls src={audioPreviewUrl} className="flex-1 h-9 min-w-0" />
                        <button
                            type="button"
                            onClick={discardVoice}
                            className="p-2 rounded-full hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
                            title={t("discard")}
                        >
                            <IconTrash className="w-4 h-4" />
                        </button>
                        <button
                            type="button"
                            onClick={sendVoice}
                            disabled={isSending}
                            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            <IconSend className="w-4 h-4" />
                            {t("send")}
                        </button>
                    </div>
                )}

                {/* State: normal text input */}
                {!isRecording && !audioPreviewUrl && (
                <form ref={formRef} onSubmit={handleSend}>
                {(pendingAttachments.length > 0 || attachError) && (
                    <div className="mb-2 space-y-2">
                        {attachError && (
                            <div className="rounded-lg border border-red-700/40 bg-red-900/40 px-3 py-2 text-xs text-red-300">
                                {attachError}
                            </div>
                        )}
                        <Presence show={pendingAttachments.length > 0} snappy>
                            <div className="flex flex-wrap gap-2">
                                <MotionList>
                                {pendingAttachments.map((att) => (
                                    <MotionItem key={att.id}>
                                        <AttachmentChip attachment={att} onRemove={() => removePendingAttachment(att.id)} />
                                    </MotionItem>
                                ))}
                                </MotionList>
                            </div>
                        </Presence>
                    </div>
                )}
                <div className="relative rounded-2xl border border-zinc-800 bg-zinc-900 transition-colors focus-within:border-zinc-600">
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={handleAttachFiles}
                        aria-label={t("attachFiles")}
                    />
                    <textarea
                        ref={composerRef}
                        value={draft}
                        onChange={(event) => handleTyping(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                event.currentTarget.form?.requestSubmit();
                            }
                        }}
                        placeholder={newChatKey ? tChats("newChatPlaceholder", { name: agentName }) : t("messagePlaceholder", { name: agentName })}
                        aria-label={t("messageLabel", { name: agentName })}
                        aria-describedby="direct-message-shortcut"
                        rows={1}
                        className="block max-h-40 min-h-11 w-full resize-none overflow-y-auto bg-transparent px-3 pt-3 pb-1 text-base leading-5 text-zinc-200 placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap placeholder:text-zinc-600 focus:outline-none sm:px-4 sm:text-sm"
                    />
                    <div className="flex items-center gap-1 px-1.5 pb-1.5 sm:px-2 sm:pb-2">
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            title={t("attachFiles")}
                            aria-label={t("attachFiles")}
                            className={composerIconButton}
                        >
                            <IconPaperclip className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={startRecording}
                            title={t("recordVoice")}
                            aria-label={t("recordVoice")}
                            className={composerIconButton}
                        >
                            <IconMicrophone className="h-4 w-4" />
                        </button>
                        {/* A New chat has nothing to stop or replace yet; objectives run in an existing chat. */}
                        {!newChatKey && <AgentGoalControls agentId={agentId} />}
                        {!newChatKey && <Select aria-label={t("nextPromptBehavior")} title={t("busyBehavior")} value={sendMode} onChange={e => setSendMode(e.target.value as "queue" | "replace")}
                            className="h-8 min-w-0 max-w-[7rem] cursor-pointer sm:max-w-[9.5rem] truncate rounded-full border border-transparent bg-transparent px-2 text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <option value="queue">{t("queueAfter")}</option>
                            <option value="replace">{t("replaceCurrent")}</option>
                        </Select>}
                        <div className="ml-auto flex items-center gap-1.5">
                            {!newChatKey && <button type="button" onClick={requestStop} disabled={isSending}
                                title={stopNeedsConfirm ? tChats("stopAllChatsTitle", { name: agentName }) : thread?.ownerUserId ? tChats("stopThisChatTitle") : t("stopTitle")}
                                aria-label={stopNeedsConfirm ? tChats("stopAllChatsLabel") : thread?.ownerUserId ? tChats("stopThisChatLabel") : t("stopLabel")}
                                className={cn(composerIconButton, activeQueueItem ? "text-red-300 hover:bg-red-500/10 hover:text-red-200" : "")}>
                                <IconPlayerStop className="h-4 w-4" />
                            </button>}
                            <button
                                type="submit"
                                disabled={(!draft.trim() && pendingAttachments.length === 0) || isSending}
                                aria-label={isSending ? t("sending") : t("sendMessage")}
                                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                            >
                                <IconArrowUp className="h-4 w-4" stroke={2.5} />
                            </button>
                        </div>
                    </div>
                </div>
                <p id="direct-message-shortcut" className="mt-1.5 hidden px-1 text-center text-[10px] text-zinc-600 sm:block">
                    {t("shortcutHint")}
                </p>
            </form>
                )}
            </div>}
            {limitReached && (
                <ChatLimitDialog
                    limit={limitReached.limit}
                    open={limitReached.open}
                    chats={chats.chats}
                    onArchived={() => chats.reload()}
                    onClose={() => setLimitReached(null)}
                    onRetry={() => {
                        setLimitReached(null);
                        if (thread?.archivedAt) void restoreChat();
                        // A voice note waiting in the preview has no form on screen: resend the clip.
                        else if (audioBlobRef.current) void sendVoice();
                        else formRef.current?.requestSubmit();
                    }}
                />
            )}
            <ConfirmDialog
                open={confirmStop !== null}
                title={confirmStop === "all" ? tChats("stopAllConfirmTitle", { name: agentName }) : tChats("stopOlderRuntimeTitle", { name: agentName })}
                description={confirmStop === "all" ? tChats("stopAllConfirmBody", { name: agentName }) : tChats("stopOlderRuntimeBody", { name: agentName })}
                confirmLabel={tChats("stopAllConfirm")}
                destructive
                onConfirm={() => void stopAgent(confirmStop === "all")}
                onCancel={() => setConfirmStop(null)}
            />
        </div>
        </RichMessageActionsContext.Provider>
    );
}

/** Set when the runtime gave up on this message after its retries (vs. an operator cancel). */
function runtimeFailureOf(message: DirectMessage): { attempts?: number | null; reason?: string | null } | null {
    const metadata = (message.metadataJson as Record<string, unknown> | null) || {};
    const failure = metadata.runtimeFailure;
    return failure && typeof failure === "object" ? failure as { attempts?: number | null; reason?: string | null } : null;
}

/** Whether a list of stopped messages failed, was cancelled, or both (directChat.stopped.*). */
function stoppedKind(messages: DirectMessage[]): "cancelled" | "failed" | "mixed" {
    const failed = messages.filter((message) => runtimeFailureOf(message)).length;
    if (failed === 0) return "cancelled";
    return failed === messages.length ? "failed" : "mixed";
}

/** Operator messages after index `i`, so a choices block knows its answer. */
function laterHumanTexts(messages: DirectMessage[], i: number): string[] {
    return messages.slice(i + 1).filter((m) => m.senderType === "human").map((m) => m.text);
}

/** A run's age, ticking every second ("23m 05s"). */
function WorkElapsed({ startedAt }: { startedAt: string }) {
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        const id = window.setInterval(() => setNowMs(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, []);
    return <>{formatElapsed(nowMs - Date.parse(startedAt))}</>;
}

function QueueItem({
    message,
    stateLabel,
    disabled,
    onCancel,
    onRetry,
}: {
    message: DirectMessage;
    stateLabel: string;
    disabled: boolean;
    onCancel?: () => void;
    onRetry?: () => void;
}) {
    const t = useTranslations("directChat");
    return (
        <div className="flex items-center gap-2 py-1.5">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", message.deliveryState === "acting" ? "bg-emerald-400 animate-pulse" : "bg-zinc-500")} />
            <div className="min-w-0 flex-1">
                <p className="line-clamp-2 break-words text-zinc-300">{queuePromptPreview(message.text)}</p>
                <p className="text-[10px] text-zinc-500">{stateLabel}</p>
            </div>
            {onCancel && (
                <button type="button" onClick={onCancel} disabled={disabled}
                    className="min-h-11 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:border-red-400/60 hover:text-red-300 disabled:opacity-50">
                    {t("cancel")}
                </button>
            )}
            {onRetry && (
                <button type="button" onClick={onRetry} disabled={disabled}
                    className="min-h-11 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:border-emerald-400/60 hover:text-emerald-300 disabled:opacity-50">
                    {t("retry")}
                </button>
            )}
        </div>
    );
}

function MessageContent({ text: rawText, isHuman }: { text: string; isHuman: boolean }) {
    // Older voice notes were sent as "🎤 Voice message (…)"; show them like new ones (no emoji).
    const text = isHuman ? rawText.replace(/^\u{1F3A4}\s*/u, "") : rawText;
    // Legacy format from before voice messages became real attachments —
    // matches both absolute URLs and the app's own relative paths (the bug:
    // this used to only match https?:// and silently fell through to
    // showing the raw "[audio:/api/...]" tag as plain text).
    const audioMatch = text.match(/\[audio:(https?:\/\/[^\]]+|\/[^\]]+)\]/);
    if (!audioMatch) {
        return (
            <MarkdownRenderer
                content={text}
                className="break-words [&_.prose]:max-w-prose [&_.prose]:text-sm [&_.prose]:leading-relaxed [&_.prose_p:first-child]:mt-0 [&_.prose_p:last-child]:mb-0 [&_.prose_p]:mb-3 [&_.prose_ul]:mb-3 [&_.prose_ol]:mb-3 [&_.prose_pre]:mb-3 [&_.prose_pre]:bg-zinc-950/70 [&_.prose_pre]:border-zinc-800/80 [&_.prose_code]:text-emerald-200 [&_.prose_a]:text-emerald-300"
            />
        );
    }
    const before = text.slice(0, audioMatch.index).replace(/\[audio:[^\]]+\]/, "").trim();
    const audioSrc = audioMatch[1];
    return (
        <div className="space-y-2">
            {before && <p className="text-sm font-medium text-muted-foreground">{before}</p>}
            <audio
                controls
                src={audioSrc}
                className="w-full max-w-[220px] h-8"
                style={{ accentColor: "var(--primary)" }}
            />
        </div>
    );
}
