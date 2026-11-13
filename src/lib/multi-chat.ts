/**
 * Several private chats per (person, agent) (docs/design/multi-chat-per-agent.md).
 *
 * Every person keeps one MAIN chat per agent (message_threads.is_main); every
 * caller that does not name a thread resolves to it. Extra chats are created by
 * the person with their first message, titled from it, and can be renamed,
 * archived and restored. Company settings: an on/off switch, a cap on open
 * chats per (person, agent) and an idle auto-archive window.
 *
 * Pure helpers only: safe to import from client components and unit tests.
 */

export const MULTI_CHAT_DEFAULTS = { enabled: true, maxOpen: 20, idleArchiveDays: 30 } as const;
/** Admin range for the open-chat cap. */
export const MULTI_CHAT_MAX_OPEN_RANGE = { min: 1, max: 50 } as const;
/** Admin range for the idle auto-archive window, in days (null = never). */
export const MULTI_CHAT_IDLE_DAYS_RANGE = { min: 7, max: 90 } as const;
/** New chats one person may start per minute. */
export const NEW_CHAT_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const;
/** Renames, archives and restores one person may make per minute. */
export const CHAT_UPDATE_RATE_LIMIT = { limit: 30, windowMs: 60_000 } as const;
/** Characters of the first message kept as an extra chat's title. */
export const CHAT_TITLE_MAX = 60;

export const ARCHIVE_REASONS = ["manual", "idle", "member_left", "agent_sealed"] as const;
export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

/** Error codes the chat routes answer with (`code` next to `error`). */
export type MultiChatErrorCode =
    | "multi_chat_disabled"
    | "chat_limit_reached"
    | "chat_archived"
    | "main_chat_cannot_be_archived"
    | "main_chat_cannot_be_renamed"
    | "objective_running"
    | "rate_limited";

/** Sending to an archived chat (people and agents alike): 409 chat_archived. */
export class ChatArchivedError extends Error {
    readonly status = 409;
    readonly code = "chat_archived";
    constructor() {
        super("This chat is archived");
        this.name = "ChatArchivedError";
    }
}

export type MultiChatSettings = { enabled: boolean; maxOpen: number; idleArchiveDays: number | null };

/** Stored columns → settings; anything missing or out of range reads as the default. */
export function normalizeMultiChatSettings(row: {
    multiChatEnabled?: unknown;
    multiChatMaxOpen?: unknown;
    multiChatIdleArchiveDays?: unknown;
} | null | undefined): MultiChatSettings {
    const enabled = typeof row?.multiChatEnabled === "boolean" ? row.multiChatEnabled : MULTI_CHAT_DEFAULTS.enabled;
    const maxOpen = isIntInRange(row?.multiChatMaxOpen, MULTI_CHAT_MAX_OPEN_RANGE) ? row!.multiChatMaxOpen as number : MULTI_CHAT_DEFAULTS.maxOpen;
    const idle = row?.multiChatIdleArchiveDays;
    const idleArchiveDays = idle === null
        ? null
        : isIntInRange(idle, MULTI_CHAT_IDLE_DAYS_RANGE) ? idle as number : MULTI_CHAT_DEFAULTS.idleArchiveDays;
    return { enabled, maxOpen, idleArchiveDays };
}

function isIntInRange(value: unknown, range: { min: number; max: number }): boolean {
    return typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max;
}

export type MultiChatSettingsPatch = Partial<MultiChatSettings>;

/**
 * Validates the multi-chat fields of a PUT /api/settings/direct-chats body.
 * Absent fields are left out of the patch; a present field must be valid.
 */
export function parseMultiChatSettingsPatch(body: unknown): { ok: true; patch: MultiChatSettingsPatch } | { ok: false; error: string } {
    const b = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const patch: MultiChatSettingsPatch = {};
    if (b.multiChatEnabled !== undefined) {
        if (typeof b.multiChatEnabled !== "boolean") return { ok: false, error: "multiChatEnabled must be true or false" };
        patch.enabled = b.multiChatEnabled;
    }
    if (b.multiChatMaxOpen !== undefined) {
        if (!isIntInRange(b.multiChatMaxOpen, MULTI_CHAT_MAX_OPEN_RANGE)) {
            return { ok: false, error: `multiChatMaxOpen must be a whole number from ${MULTI_CHAT_MAX_OPEN_RANGE.min} to ${MULTI_CHAT_MAX_OPEN_RANGE.max}` };
        }
        patch.maxOpen = b.multiChatMaxOpen as number;
    }
    if (b.multiChatIdleArchiveDays !== undefined) {
        if (b.multiChatIdleArchiveDays !== null && !isIntInRange(b.multiChatIdleArchiveDays, MULTI_CHAT_IDLE_DAYS_RANGE)) {
            return { ok: false, error: `multiChatIdleArchiveDays must be null or a whole number from ${MULTI_CHAT_IDLE_DAYS_RANGE.min} to ${MULTI_CHAT_IDLE_DAYS_RANGE.max}` };
        }
        patch.idleArchiveDays = b.multiChatIdleArchiveDays as number | null;
    }
    return { ok: true, patch };
}

/** Whether one more chat may be opened with `open` chats already open and a cap of `limit`. */
export function chatLimitReached(open: number, limit: number): boolean {
    return open >= limit;
}

/**
 * An extra chat's title from its first message: whitespace collapsed, the first
 * CHAT_TITLE_MAX characters (an ellipsis when cut, never a split surrogate
 * pair). No model call. Empty text (an attachment-only first message) gives
 * null: the chat is untitled and the interface shows its own "Untitled chat".
 */
export function deriveChatTitle(text: string | null | undefined): string | null {
    const flat = (text ?? "").replace(/\s+/g, " ").trim();
    if (!flat) return null;
    const chars = Array.from(flat);
    if (chars.length <= CHAT_TITLE_MAX) return flat;
    return `${chars.slice(0, CHAT_TITLE_MAX - 1).join("").trimEnd()}…`;
}

/** The caption the composer sends with a voice note ("Voice message (12s)", older ones with a 🎤). */
const VOICE_CAPTION_RE = /^(?:🎤\s*)?Voice message \([^)]*\)$/u;

/**
 * The title of a new chat from its first message and attachments: a voice
 * note's generated English caption is not a title, so a chat started with one
 * is untitled (null), like an attachment-only one.
 */
export function newChatTitle(text: string | null | undefined, attachments: readonly { contentType?: string | null }[] = []): string | null {
    const flat = (text ?? "").trim();
    const allAudio = attachments.length > 0 && attachments.every((a) => (a.contentType ?? "").toLowerCase().startsWith("audio/"));
    if (allAudio && VOICE_CAPTION_RE.test(flat)) return null;
    return deriveChatTitle(text);
}

/** A rename: whitespace collapsed, 1..CHAT_TITLE_MAX * 2 characters; null when invalid. */
export function normalizeChatTitle(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const flat = value.replace(/\s+/g, " ").trim();
    if (!flat || Array.from(flat).length > CHAT_TITLE_MAX * 2) return null;
    return flat;
}

/** Client keys are opaque ids from the browser (one per "New chat" composer). */
const CLIENT_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

export function isValidClientKey(value: unknown): value is string {
    return typeof value === "string" && CLIENT_KEY_RE.test(value);
}

/* ---------- Interface helpers (P2): the chat switcher and "All chats" ---------- */

/** One of the person's chats with an agent, as GET /api/chat/threads lists it. */
export type ChatListEntry = {
    id: string;
    title: string | null;
    isMain: boolean;
    createdAt: string;
    lastMessageAt: string | null;
    unread: number;
    running: boolean;
    queued: number;
    archivedAt?: string | null;
    archiveReason?: string | null;
};

/** Chats the header switcher lists before "All chats". */
export const SWITCHER_RECENT_LIMIT = 8;
/** From this many open chats the switcher shows "15 of 20". */
export const COUNT_HINT_FROM = 15;
/** Least recently used chats the cap dialog offers to archive. */
export const CAP_DIALOG_SUGGESTIONS = 5;

/** Last activity of a chat (its last message, else its creation), in ms. */
export function chatActivityMs(chat: Pick<ChatListEntry, "lastMessageAt" | "createdAt">): number {
    const value = Date.parse(chat.lastMessageAt ?? chat.createdAt);
    return Number.isNaN(value) ? 0 : value;
}

/** Main chat pinned first, then by last activity, newest first. */
export function orderChats<T extends ChatListEntry>(chats: readonly T[]): T[] {
    return [...chats].sort((a, b) => Number(b.isMain) - Number(a.isMain) || chatActivityMs(b) - chatActivityMs(a));
}

/** What the header switcher shows: main + the most recent, up to `limit` rows; `more` = chats left for "All chats". */
export function switcherChats<T extends ChatListEntry>(chats: readonly T[], limit = SWITCHER_RECENT_LIMIT): { shown: T[]; more: number } {
    const ordered = orderChats(chats);
    return { shown: ordered.slice(0, limit), more: Math.max(0, ordered.length - limit) };
}

export type ChatRecencyGroups<T> = { today: T[]; last7Days: T[]; older: T[] };

/**
 * "Today / Last 7 days / Older" by last activity, in the viewer's local day:
 * today = since local midnight, last 7 days = the six days before it.
 * Each group is newest first.
 */
export function groupChatsByRecency<T extends ChatListEntry>(chats: readonly T[], now: Date = new Date()): ChatRecencyGroups<T> {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
    const groups: ChatRecencyGroups<T> = { today: [], last7Days: [], older: [] };
    for (const chat of [...chats].sort((a, b) => chatActivityMs(b) - chatActivityMs(a))) {
        const at = chatActivityMs(chat);
        if (at >= startOfToday) groups.today.push(chat);
        else if (at >= startOfWeek) groups.last7Days.push(chat);
        else groups.older.push(chat);
    }
    return groups;
}

/** Case-insensitive title filter; `label` names untitled and main chats as the viewer sees them. */
export function filterChatsByTitle<T extends ChatListEntry>(chats: readonly T[], query: string, label: (chat: T) => string): T[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [...chats];
    return chats.filter((chat) => label(chat).toLocaleLowerCase().includes(needle));
}

/**
 * The chats the cap dialog offers to archive: open extra chats (never the
 * main chat, never one the agent is working in), least recently used first.
 */
export function leastRecentlyUsedChats<T extends ChatListEntry>(chats: readonly T[], count = CAP_DIALOG_SUGGESTIONS): T[] {
    return chats
        .filter((chat) => !chat.isMain && !chat.archivedAt && !chat.running && chat.queued === 0)
        .sort((a, b) => chatActivityMs(a) - chatActivityMs(b))
        .slice(0, count);
}

/** "15 of 20" once the person is close to the cap (from COUNT_HINT_FROM, or at the cap when it is lower). */
export function chatCountHint(open: number, limit: number): { open: number; limit: number } | null {
    return open >= COUNT_HINT_FROM || open >= limit ? { open, limit } : null;
}

/**
 * Whether this chat's last message waits because the agent is busy elsewhere,
 * and in how many of the person's OTHER chats with it. `maxParallelTurns` is
 * what the runtime reports; unknown (null) counts as 1, so the hint errs on the
 * honest side. Busy-ness counts every run elsewhere (tasks and other people's
 * chats fill the runtime too); `others` counts only runs in `ownChatIds` (the
 * person's chats with the agent, from the chat list) other than this one, so
 * "working in N other chats" never counts work the person cannot see.
 * Without `ownChatIds`, every run elsewhere counts.
 */
export function queuedBusyState(input: {
    lastMessageQueued: boolean;
    runningThreadIds: readonly (string | null)[];
    currentThreadId: string | null;
    maxParallelTurns: number | null;
    ownChatIds?: readonly string[];
}): { show: boolean; others: number } {
    const elsewhere = input.runningThreadIds.filter((id) => !input.currentThreadId || id !== input.currentThreadId);
    const own = input.ownChatIds ? new Set(input.ownChatIds) : null;
    const others = own ? elsewhere.filter((id) => id !== null && own.has(id)).length : elsewhere.length;
    const cap = input.maxParallelTurns ?? 1;
    return { show: input.lastMessageQueued && elsewhere.length > 0 && elsewhere.length >= cap, others };
}

/** A fresh client key for one "New chat" composer (kept for retries, so a double submit makes one chat). */
export function newChatClientKey(): string {
    const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    return `nc-${random}`;
}
