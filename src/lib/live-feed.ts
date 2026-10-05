import { createHash } from "crypto";
import { and, count, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { approvals, companies, messageThreads, tasks, threadMessages, threadParticipants } from "@/db/schema";
import { computeCompanyHealth, type CompanyHealth, type HealthStatus } from "@/lib/agent-health";
import { taskTitle } from "@/lib/emperor-entities";
import { SLA_TRACKED_TASK_STATES, TASK_STATES } from "@/lib/task-state";

/**
 * The live agent feed (GET /api/mcp/live): a small, read-only snapshot of what
 * every agent is doing, for physical screens and dashboards. The first
 * consumer is a 240x240 ESP32 display that parses it with ArduinoJson on
 * ~200 KB of heap, so the payload is deliberately tiny, flat, and stable:
 * every key is always present (null, never omitted) and strings are short,
 * plain text. The keys are a firmware contract — bump `v` on any change that
 * is not purely additive.
 */

export const LIVE_FEED_VERSION = 1;
export const LIVE_MAX_AGENTS = 24;
export const LIVE_DEFAULT_MESSAGES = 8;
export const LIVE_MAX_MESSAGES = 20;
const SHORT_NAME_MAX = 10;
const ACTIVITY_MAX = 80;
const TASK_TITLE_MAX = 60;
const MESSAGE_TEXT_MAX = 100;
/** Only this much of a message is read from the DB before stripping. */
const MESSAGE_SCAN_CHARS = 2000;
/** Health scans a week of messages; a screen polling every few seconds reuses it briefly. */
const HEALTH_CACHE_MS = 10_000;
/** Only team chat and group threads reach a screen — never private direct threads. */
const PUBLIC_THREAD_TYPES = ["team", "group"] as const;
const PRIVATE_ACTIVITY = "Working in a private chat";

export type LiveState = "typing" | "working" | "idle" | "offline";

export interface LiveAgent {
    id: string;
    name: string;
    short: string;
    hue: number;
    health: HealthStatus;
    state: LiveState;
    activity: string | null;
    task: { id: string; title: string } | null;
    lastSeenSec: number | null;
    unanswered: number;
}

export interface LiveMessage {
    id: string;
    from: string;
    agentId: string | null;
    text: string;
    ageSec: number;
}

export interface LiveFeed {
    v: number;
    ts: string;
    company: { name: string };
    summary: {
        agents: number;
        healthy: number;
        attention: number;
        down: number;
        idle: number;
        working: number;
        pendingApprovals: number;
        tasksInProgress: number;
        tasksOverdue: number;
    };
    agents: LiveAgent[];
    messages: LiveMessage[];
}

// ─── Pure helpers (unit-tested) ────────────────────────────────────────────

/** Truncate by code point (never splitting an emoji), ending in ASCII "..." — screen fonts rarely have "…". */
export function truncateText(value: string, max: number): string {
    const chars = Array.from(value);
    if (chars.length <= max) return value;
    return `${chars.slice(0, Math.max(0, max - 3)).join("").trimEnd()}...`;
}

/** First word of a name, at most 10 characters. */
export function shortName(name: string | null | undefined, fallback = "Agent"): string {
    const first = (name || "").trim().split(/\s+/)[0] || fallback;
    return Array.from(first).slice(0, SHORT_NAME_MAX).join("");
}

/** A stable 0-359 hue from an id (FNV-1a), so an agent keeps its color on every screen. */
export function agentHue(id: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
        hash ^= id.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) % 360;
}

const RICH_FENCE_RE = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;

/** Markdown and rich blocks to one line of plain text, at most `max` characters. */
export function toPlainText(input: string | null | undefined, max = MESSAGE_TEXT_MAX): string {
    let text = (input || "").replace(/\r\n?/g, "\n");
    // Fenced blocks: rich blocks become a short tag, code becomes [code].
    text = text.replace(RICH_FENCE_RE, (_match, lead: string, _fence: string, lang: string) => {
        const language = (lang || "").toLowerCase();
        const tag = ["chart", "stats", "tabs", "html", "choices"].includes(language) ? language : "code";
        return `${lead}[${tag}] `;
    });
    text = text
        .replace(/<[^>\n]+>/g, " ")                              // HTML tags
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")                // images -> alt
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")                 // links (incl. emperor://) -> label
        .replace(/`([^`]+)`/g, "$1")                             // inline code
        .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, " ") // table rules
        .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, " ")   // horizontal rules
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")                    // headings
        .replace(/^[ \t]*>[ \t]?/gm, "")                         // blockquotes
        .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "") // list markers, checkboxes
        .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")         // bold
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")                // strikethrough
        .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2") // *italic*
        .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")  // _italic_ (not snake_case)
        .replace(/\|/g, " ")                                     // table cells
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
    return truncateText(text, max);
}

/**
 * What a screen shows an agent doing. In priority order:
 *  - typing:  a runtime reported it is composing (typingUntil in the future)
 *  - offline: not seen for OFFLINE_AFTER_MS (5 min) — the same rule health
 *             uses for "online", so the two never disagree
 *  - working: it holds an in_progress task
 *  - idle:    online with nothing in progress
 * Typing wins over offline: a runtime that is typing right now is plainly alive.
 */
export function deriveLiveState(input: { typing: boolean; online: boolean; hasTaskInProgress: boolean }): LiveState {
    if (input.typing) return "typing";
    if (!input.online) return "offline";
    if (input.hasTaskInProgress) return "working";
    return "idle";
}

/** ?messages= → 0..20, default 8. */
export function clampMessageCount(raw: string | null | undefined): number {
    if (raw === null || raw === undefined || raw.trim() === "") return LIVE_DEFAULT_MESSAGES;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return LIVE_DEFAULT_MESSAGES;
    return Math.min(LIVE_MAX_MESSAGES, Math.max(0, parsed));
}

/**
 * ETag over everything a screen renders EXCEPT the clocks (`ts`, `ageSec`,
 * `lastSeenSec`), which change every second and would defeat 304s. A device
 * that gets a 304 ages its cached clocks by the time since its last 200. Any
 * real change (state, activity, health, task, a new message) changes the tag.
 */
export function liveFeedEtag(feed: LiveFeed): string {
    const stable = {
        ...feed,
        ts: undefined,
        agents: feed.agents.map((a) => ({ ...a, lastSeenSec: undefined })),
        messages: feed.messages.map((m) => ({ ...m, ageSec: undefined })),
    };
    const digest = createHash("sha256").update(JSON.stringify(stable)).digest("base64url").slice(0, 22);
    return `"${digest}"`;
}

/** Does an If-None-Match header match this ETag? Handles lists, W/ and "*". */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
    if (!ifNoneMatch) return false;
    return ifNoneMatch.split(",").some((part) => {
        const candidate = part.trim().replace(/^W\//, "");
        return candidate === "*" || candidate === etag;
    });
}

// ─── Snapshot ──────────────────────────────────────────────────────────────

const healthCache = new Map<string, { at: number; value: CompanyHealth }>();

// Concurrent cold-cache polls share one computation instead of each scanning
// a week of messages.
const healthInFlight = new Map<string, Promise<CompanyHealth>>();

async function getCachedHealth(companyId: string, now: Date): Promise<CompanyHealth> {
    const hit = healthCache.get(companyId);
    if (hit && now.getTime() - hit.at < HEALTH_CACHE_MS) return hit.value;
    const pending = healthInFlight.get(companyId);
    if (pending) return pending;
    const promise = computeCompanyHealth(companyId, { now });
    healthInFlight.set(companyId, promise);
    let value: CompanyHealth;
    try {
        value = await promise;
    } finally {
        healthInFlight.delete(companyId);
    }
    healthCache.set(companyId, { at: now.getTime(), value });
    // Bounded: drop entries that have expired.
    if (healthCache.size > 256) {
        for (const [key, entry] of healthCache) {
            if (now.getTime() - entry.at >= HEALTH_CACHE_MS) healthCache.delete(key);
        }
    }
    return value;
}

/** Test hook: forget cached health. */
export function clearLiveFeedCache() {
    healthCache.clear();
    healthInFlight.clear();
}

const STATE_ORDER: Record<LiveState, number> = { typing: 0, working: 0, idle: 0, offline: 1 };

export async function buildLiveFeed(companyId: string, options: { messages?: number; now?: Date } = {}): Promise<LiveFeed> {
    const now = options.now ?? new Date();
    const messageLimit = Math.min(LIVE_MAX_MESSAGES, Math.max(0, options.messages ?? LIVE_DEFAULT_MESSAGES));

    const [health, companyRows, taskCounts, agentTasks, approvalCount, typingRows, messageRows] = await Promise.all([
        getCachedHealth(companyId, now),
        db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1),
        db.select({
            inProgress: sql<number>`count(*) filter (where ${tasks.state} = ${TASK_STATES.inProgress})`,
            overdue: sql<number>`count(*) filter (where ${inArray(tasks.state, [...SLA_TRACKED_TASK_STATES])} and ${lt(tasks.slaDueAt, now)})`,
        }).from(tasks).where(and(eq(tasks.companyId, companyId), isNull(tasks.deletedAt))),
        // Each agent's most relevant in-progress task: highest priority, then most recently touched.
        db.selectDistinctOn([tasks.assignedAgentId], {
            id: tasks.id,
            agentId: tasks.assignedAgentId,
            title: sql<string | null>`${tasks.inputJson}->>'title'`,
            taskType: tasks.taskType,
        }).from(tasks)
            .where(and(
                eq(tasks.companyId, companyId),
                isNull(tasks.deletedAt),
                eq(tasks.state, TASK_STATES.inProgress),
                sql`${tasks.assignedAgentId} is not null`,
            ))
            .orderBy(tasks.assignedAgentId, desc(tasks.priority), desc(tasks.updatedAt)),
        db.select({ value: count() }).from(approvals).where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending"))),
        db.select({
            agentId: threadParticipants.participantId,
            typingUntil: threadParticipants.typingUntil,
            activity: threadParticipants.currentActivity,
            threadType: messageThreads.type,
        }).from(threadParticipants)
            .innerJoin(messageThreads, eq(messageThreads.id, threadParticipants.threadId))
            .where(and(
                eq(threadParticipants.companyId, companyId),
                eq(threadParticipants.participantType, "agent"),
                gt(threadParticipants.typingUntil, now),
            )),
        messageLimit === 0
            ? Promise.resolve([])
            : db.select({
                id: threadMessages.id,
                senderType: threadMessages.senderType,
                senderId: threadMessages.senderId,
                senderName: sql<string | null>`${threadMessages.metadataJson}->>'senderName'`,
                runtimeControl: sql<boolean>`(${threadMessages.metadataJson} -> 'runtimeControl') is not null`,
                text: sql<string>`left(${threadMessages.text}, ${MESSAGE_SCAN_CHARS})`,
                createdAt: threadMessages.createdAt,
            }).from(threadMessages)
                .innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
                .where(and(
                    eq(threadMessages.companyId, companyId),
                    eq(messageThreads.companyId, companyId),
                    inArray(messageThreads.type, [...PUBLIC_THREAD_TYPES]),
                    isNull(messageThreads.archivedAt),
                ))
                .orderBy(desc(threadMessages.createdAt))
                // Headroom for messages that strip to nothing (control notices, empty bodies).
                .limit(messageLimit + 10),
    ]);

    // Freshest live activity per agent. Activity from a private direct thread
    // can quote that conversation (reasoning lines), so a screen only learns
    // that the agent is busy in one, never what it is saying.
    const typing = new Map<string, { until: number; activity: string | null }>();
    for (const row of typingRows) {
        if (!row.agentId || !row.typingUntil) continue;
        const raw = row.activity?.trim() ? row.activity : null;
        const activity = raw && !(PUBLIC_THREAD_TYPES as readonly string[]).includes(row.threadType) ? PRIVATE_ACTIVITY : raw;
        const current = typing.get(row.agentId);
        const until = row.typingUntil.getTime();
        if (!current || (activity && !current.activity) || (Boolean(activity) === Boolean(current.activity) && until > current.until)) {
            typing.set(row.agentId, { until, activity });
        }
    }
    const taskByAgent = new Map(agentTasks.filter((t) => t.agentId).map((t) => [t.agentId!, t]));

    const all: LiveAgent[] = health.agents.map((a) => {
        const live = typing.get(a.id);
        const task = taskByAgent.get(a.id);
        const lastSeenMs = a.lastSeenAt ? Date.parse(a.lastSeenAt) : NaN;
        return {
            id: a.id,
            name: a.name,
            short: shortName(a.name),
            hue: agentHue(a.id),
            health: a.status,
            state: deriveLiveState({ typing: Boolean(live), online: a.online, hasTaskInProgress: Boolean(task) }),
            activity: live?.activity ? toPlainText(live.activity, ACTIVITY_MAX) || null : null,
            task: task ? { id: task.id, title: truncateText(taskTitle({ inputJson: { title: task.title }, taskType: task.taskType }), TASK_TITLE_MAX) } : null,
            lastSeenSec: Number.isFinite(lastSeenMs) ? Math.max(0, Math.floor((now.getTime() - lastSeenMs) / 1000)) : null,
            unanswered: a.unanswered,
        };
    });
    // Stable order for a carousel: online agents first, then offline, each by
    // name. Typing/working flip every few seconds, so they don't reorder.
    all.sort((x, y) => STATE_ORDER[x.state] - STATE_ORDER[y.state] || x.name.localeCompare(y.name) || x.id.localeCompare(y.id));

    const agentNames = new Map(health.agents.map((a) => [a.id, a.name]));
    const messages: LiveMessage[] = [];
    for (const m of messageRows) {
        if (messages.length >= messageLimit) break;
        if (m.runtimeControl) continue;
        const text = toPlainText(m.text, MESSAGE_TEXT_MAX);
        if (!text) continue;
        const isAgent = m.senderType === "agent" && Boolean(m.senderId) && agentNames.has(m.senderId!);
        const from = isAgent
            ? shortName(agentNames.get(m.senderId!))
            : m.senderType === "agent"
                ? "Agent"
                : m.senderType === "system"
                    ? shortName(m.senderName, "System")
                    : shortName(m.senderName, "Someone");
        messages.push({
            id: m.id,
            from,
            agentId: isAgent ? m.senderId : null,
            text,
            ageSec: Math.max(0, Math.floor((now.getTime() - m.createdAt.getTime()) / 1000)),
        });
    }

    const tally = (status: HealthStatus) => all.filter((a) => a.health === status).length;
    return {
        v: LIVE_FEED_VERSION,
        ts: now.toISOString(),
        company: { name: companyRows[0]?.name ?? "" },
        summary: {
            agents: all.length,
            healthy: tally("healthy"),
            attention: tally("attention"),
            down: tally("down"),
            idle: tally("idle"),
            // Actively doing something right now: typing or holding an in-progress task.
            working: all.filter((a) => a.state === "typing" || a.state === "working").length,
            pendingApprovals: Number(approvalCount[0]?.value) || 0,
            tasksInProgress: Number(taskCounts[0]?.inProgress) || 0,
            tasksOverdue: Number(taskCounts[0]?.overdue) || 0,
        },
        agents: all.slice(0, LIVE_MAX_AGENTS),
        messages,
    };
}
