import { resolveAppearance } from "@/lib/character/model";
import { createHash } from "crypto";
import { and, count, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { approvals, companies, companyMembers, messageThreads, tasks, threadMessages, threadParticipants } from "@/db/schema";
import { computeCompanyHealth, scoreAgent, type CompanyHealth, type HealthStatus } from "@/lib/agent-health";
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
 *
 * Private direct chats never reach a screen, with one opt-in exception: a
 * read_only token minted with "include my private chats" carries its
 * creator's own exchanges with each agent in `dm` (see buildDmFeed).
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
/** `dm`: at most this many messages per agent, and this many in total. */
export const LIVE_DM_PER_AGENT = 4;
export const LIVE_DM_MAX_MESSAGES = 40;
/** How far back in a direct thread the creator's exchanges are looked for. */
const DM_SCAN_MESSAGES = 40;

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

export interface LiveDmMessage {
    id: string;
    /** Written by the token's creator (otherwise: the agent's reply to them). */
    me: boolean;
    text: string;
    ageSec: number;
}

export interface LiveDmThread {
    agentId: string;
    /** Newest first. */
    messages: LiveDmMessage[];
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
    /** The token creator's own direct chats with each agent; [] unless opted in. */
    dm: LiveDmThread[];
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

/** Reuse the configured web avatar color on constrained physical displays. */
export function agentHue(id: string, source: { avatarUrl?: string | null; avatarAppearance?: unknown } = {}): number {
    return resolveAppearance({ id, ...source }).hue;
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
        dm: (feed.dm ?? []).map((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, ageSec: undefined })) })),
    };
    const digest = createHash("sha256").update(JSON.stringify(stable)).digest("base64url").slice(0, 22);
    return `"${digest}"`;
}

export interface DmRow {
    agentId: string;
    /** Newest first; already restricted to the creator's exchanges. */
    messages: { id: string; me: boolean; text: string; createdAtMs: number }[];
}

/**
 * Shape the creator's direct-chat rows into `dm`: plain text, at most
 * LIVE_DM_PER_AGENT per agent (newest first), only agents the screen shows,
 * and at most LIVE_DM_MAX_MESSAGES overall — the most recently active agents
 * win when the cap bites.
 */
export function shapeDm(rows: DmRow[], visibleAgentIds: ReadonlySet<string>, nowMs: number): LiveDmThread[] {
    const threads: { thread: LiveDmThread; newest: number }[] = [];
    for (const row of rows) {
        if (!visibleAgentIds.has(row.agentId)) continue;
        const messages: LiveDmMessage[] = [];
        let newest = -Infinity;
        for (const m of [...row.messages].sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1))) {
            if (messages.length >= LIVE_DM_PER_AGENT) break;
            const text = toPlainText(m.text, MESSAGE_TEXT_MAX);
            if (!text) continue;
            newest = Math.max(newest, m.createdAtMs);
            messages.push({ id: m.id, me: m.me, text, ageSec: Math.max(0, Math.floor((nowMs - m.createdAtMs) / 1000)) });
        }
        if (messages.length) threads.push({ thread: { agentId: row.agentId, messages }, newest });
    }
    threads.sort((a, b) => b.newest - a.newest || a.thread.agentId.localeCompare(b.thread.agentId));
    const out: LiveDmThread[] = [];
    let total = 0;
    for (const { thread } of threads) {
        const room = LIVE_DM_MAX_MESSAGES - total;
        if (room <= 0) break;
        const messages = thread.messages.slice(0, room);
        out.push({ agentId: thread.agentId, messages });
        total += messages.length;
    }
    return out;
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

/**
 * The token creator's exchanges in each agent's direct chat, in ONE query.
 *
 * "An agent's direct chat" is resolved exactly as the app's chat does
 * (ensureDirectThread in control-plane.ts): the oldest non-archived thread of
 * type "direct" in this company that has the agent as a participant. That
 * channel is SHARED by every company member (one thread per agent, not per
 * user), so the thread as a whole is never sent. Only these messages are:
 *  - human messages whose sender is the creator (me: true);
 *  - that agent's replies to the creator: a reply naming one of the creator's
 *    messages (metadata.replyToMessageId), or, when it names none, an agent
 *    message whose exchange the creator opened (the latest non-agent message
 *    before it is the creator's). This is the exchange rule agent requests
 *    already use (repliesTo in agent-requests.ts).
 * Other members' messages, system messages, other agents, and replies to
 * anyone else are excluded. Only the last DM_SCAN_MESSAGES messages of each
 * thread are considered; a reply whose exchange starts before that window is
 * dropped rather than guessed. `creatorTurn` says whether the thread's latest
 * non-agent message is the creator's (the agent is answering them right now).
 */
async function loadCreatorDirectChats(companyId: string, userId: string) {
    type Row = { agent_id: string; thread_id: string; creator_turn: boolean | null; messages: { id: string; me: boolean; text: string | null; ms: number | string }[] | null };
    const result = await db.execute<Row>(sql`
        with direct as (
            select distinct on (tp.participant_id) tp.participant_id as agent_id, t.id as thread_id
              from thread_participants tp
              join message_threads t on t.id = tp.thread_id
             where tp.company_id = ${companyId}
               and tp.participant_type = 'agent'
               and t.company_id = ${companyId}
               and t.type = 'direct'
               and t.archived_at is null
             order by tp.participant_id, t.created_at
        )
        select d.agent_id, d.thread_id,
            (select h.sender_type = 'human' and h.sender_id = ${userId}
               from thread_messages h
              where h.thread_id = d.thread_id and h.company_id = ${companyId} and h.sender_type <> 'agent'
              order by h.created_at desc, h.id desc
              limit 1) as creator_turn,
            (select json_agg(json_build_object('id', s.id, 'me', s.me, 'text', s.text, 'ms', s.ms) order by s.created_at desc, s.id desc)
               from (
                   with q as (
                       select tm.id, tm.sender_type, tm.sender_id, tm.created_at,
                              left(tm.text, ${MESSAGE_SCAN_CHARS}) as text,
                              (tm.metadata_json -> 'runtimeControl') is not null as runtime_control,
                              tm.metadata_json ->> 'replyToMessageId' as reply_to
                         from thread_messages tm
                        where tm.thread_id = d.thread_id and tm.company_id = ${companyId}
                        order by tm.created_at desc, tm.id desc
                        limit ${DM_SCAN_MESSAGES}
                   ),
                   grouped as (
                       select q.*, count(*) filter (where q.sender_type <> 'agent')
                                   over (order by q.created_at, q.id rows between unbounded preceding and current row) as grp
                         from q
                   ),
                   anchored as (
                       select g.*, first_value(case when g.sender_type <> 'agent' then g.sender_type || ':' || coalesce(g.sender_id, '') end)
                                   over (partition by g.grp order by g.created_at, g.id) as anchor
                         from grouped g
                   )
                   select a.id, a.sender_type = 'human' as me, a.text, a.created_at,
                          extract(epoch from a.created_at) * 1000 as ms
                     from anchored a
                    where (a.sender_type = 'human' and a.sender_id = ${userId})
                       or (a.sender_type = 'agent'
                           and a.sender_id = d.agent_id::text
                           and not a.runtime_control
                           and case when a.reply_to is not null
                                    then exists (select 1 from q p where p.id::text = a.reply_to and p.sender_type = 'human' and p.sender_id = ${userId})
                                    else a.grp > 0 and a.anchor = ${`human:${userId}`}
                               end)
                    order by a.created_at desc, a.id desc
                    limit ${LIVE_DM_PER_AGENT + 4}
               ) s) as messages
          from direct d
    `);
    return result.rows.map((r) => ({
        agentId: r.agent_id,
        threadId: r.thread_id,
        creatorTurn: r.creator_turn === true,
        messages: (r.messages ?? []).map((m) => ({ id: m.id, me: m.me, text: m.text ?? "", createdAtMs: Number(m.ms) })),
    }));
}

/**
 * Can this user still mint such a token? Only owners and admins create tokens,
 * so a creator who left the company or was demoted takes `dm` off the screen.
 */
async function isCompanyAdmin(companyId: string, userId: string): Promise<boolean> {
    const rows = await db.select({ role: companyMembers.role }).from(companyMembers)
        .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId))).limit(1);
    return rows[0]?.role === "owner" || rows[0]?.role === "admin";
}

/** null when the feed carries no private chats (not opted in, or the creator left or lost admin). */
async function loadPrivateChats(companyId: string, userId: string | null | undefined) {
    if (!userId) return null;
    // Check first: the chat query is the expensive part and runs on every poll.
    if (!(await isCompanyAdmin(companyId, userId))) return null;
    return loadCreatorDirectChats(companyId, userId);
}

const STATE_ORDER: Record<LiveState, number> = { typing: 0, working: 0, idle: 0, offline: 1 };

export async function buildLiveFeed(companyId: string, options: {
    messages?: number;
    now?: Date;
    /** The token creator whose own direct chats the feed may carry (opted-in read_only tokens only). */
    privateChatsUserId?: string | null;
} = {}): Promise<LiveFeed> {
    const now = options.now ?? new Date();
    const messageLimit = Math.min(LIVE_MAX_MESSAGES, Math.max(0, options.messages ?? LIVE_DEFAULT_MESSAGES));

    const [health, companyRows, taskCounts, agentTasks, approvalCount, typingRows, messageRows, privateChats] = await Promise.all([
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
            threadId: threadParticipants.threadId,
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
        loadPrivateChats(companyId, options.privateChatsUserId),
    ]);

    // Freshest live activity per agent. Activity from a private direct thread
    // can quote that conversation (reasoning lines), so a screen only learns
    // that the agent is busy in one, never what it is saying. The exception: a
    // screen carrying its creator's private chats sees the real activity when
    // the agent is answering the creator (their message opened the exchange).
    const creatorTurnThreads = new Set((privateChats ?? []).filter((c) => c.creatorTurn).map((c) => c.threadId));
    const typing = new Map<string, { until: number; activity: string | null }>();
    for (const row of typingRows) {
        if (!row.agentId || !row.typingUntil) continue;
        const raw = row.activity?.trim() ? row.activity : null;
        const visible = (PUBLIC_THREAD_TYPES as readonly string[]).includes(row.threadType) || creatorTurnThreads.has(row.threadId);
        const activity = raw && !visible ? PRIVATE_ACTIVITY : raw;
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
            hue: agentHue(a.id, a),
            health: scoreAgent({ ...a, online: Boolean(live) || a.online }).status,
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

    const shown = all.slice(0, LIVE_MAX_AGENTS);
    const dm = privateChats ? shapeDm(privateChats, new Set(shown.map((a) => a.id)), now.getTime()) : [];

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
        agents: shown,
        messages,
        dm,
    };
}
