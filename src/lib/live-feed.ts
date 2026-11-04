import { resolveAppearance } from "@/lib/character/model";
import { createHash } from "crypto";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, approvals, companies, companyMembers, incidents, messageThreads, taskEvents, tasks, threadMessageReasoning, threadMessages, threadParticipants } from "@/db/schema";
import { computeCompanyHealth, scoreAgent, type CompanyHealth, type HealthStatus } from "@/lib/agent-health";
import { taskTitle } from "@/lib/emperor-entities";
import { loadRunThoughtRows, PRIVATE_ACTIVITY, screenAscii, screenStepsFromRuns, screenThoughtsFromRuns, type RunThoughtRow } from "@/lib/run-thoughts";
import { AGENT_PAIR_DESCRIPTION } from "@/lib/groups";
import { companyTimezoneFrom } from "@/lib/pipeline-schedule";
import { SLA_TRACKED_TASK_STATES, TASK_STATES } from "@/lib/task-state";
import {
    approvalTitle, cleanSnippet, deriveActs, deriveEvents, deriveNeeds, fitThoughtsToBudget, isLiveProblemIncident, LIVE_RECENT_MS, packLook, pickThoughts,
    recentlyDoneAgents,
    type LiveAct, type LiveEvent, type LiveLook, type LiveMood, type LiveNeed, type PendingApprovalRow, type ReasoningRow,
} from "@/lib/live-feed-v2";

/**
 * The live agent feed (GET /api/mcp/live): a small, read-only snapshot of what
 * every agent is doing, for physical screens and dashboards. The first
 * consumer is a 240x240 ESP32 display that parses it with ArduinoJson on
 * ~200 KB of heap, so the payload is deliberately tiny, flat, and stable:
 * every v1 key is always present (null, never omitted) and strings are short,
 * plain text. The keys are a firmware contract — bump `v` on any change that
 * is not purely additive. v2 (devices/throne-display/V2_PLAN.md) adds `look`,
 * `act`, `mood`, optional `thought`/`thoughtAgeSec` per agent, and top-level
 * `events` and `needs`; a v1 device ignores them. 2.1 (still v2, additive)
 * adds optional per-agent `step` (the running run's current step) and `last`
 * (the latest finished task). Names: `name` is the full name and `short` stays
 * the first word (≤10 chars) for older firmware; 2.1 firmware shows `name`
 * whenever it fits the pixel width and falls back to `short`.
 *
 * Private direct chats never reach a screen, with one opt-in exception: a
 * read_only token minted with "include my private chats" carries its
 * creator's own exchanges with each agent in `dm` (see buildDmFeed).
 */

export const LIVE_FEED_VERSION = 2;
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
    /** v2: compact character spec from the agent's resolved appearance. */
    look: LiveLook;
    /** v2: what the web office scene shows the agent doing. */
    act: LiveAct;
    /** v2: the scene's expression for that activity. */
    mood: LiveMood;
    /** v2: latest redacted reasoning snippet (≤140 chars); omitted when none, stale or private. */
    thought?: string;
    thoughtAgeSec?: number;
    /**
     * 2.1: the current step of the agent's running run (same line as the
     * dashboard). `label` is always generic ("Thinking", "Running terminal");
     * `text` is the step's real detail, only on a thoughts-opted-in token for
     * a run the screen may read. Omitted when the agent has no running run.
     */
    step?: LiveStep;
    /** 2.1: the agent's most recently finished task (last 7 days); idle and offline agents only. */
    last?: LiveLast;
}

export interface LiveStep {
    label: string;
    text?: string;
    /** Seconds since the step started. */
    sec: number;
    /** Step identity for the ETag only: non-enumerable, never serialized. */
    readonly key?: string;
}

export interface LiveLast {
    title: string;
    ageSec: number;
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
    /** v2: handoffs, completions, blocks and new approvals from the last 10 minutes, newest first. */
    events: LiveEvent[];
    /** v2: up to 3 pending approvals waiting on a human. */
    needs: LiveNeed[];
    /** 2.2: today's usage of the agents on this screen (since local midnight). */
    today?: LiveToday;
}

/**
 * Today's usage, since midnight in the company's timezone (the agent
 * routine's), else UTC — only the runs and finished tasks of the agents the
 * screen shows. Rounded so the ETag does not churn: cost in whole cents,
 * tokens in thousands.
 */
export interface LiveToday {
    /** Sum of agent_runs.cost_cents; null when no run today reported a cost. */
    cost: number | null;
    runs: number;
    /** Input + output tokens, in thousands (rounded). */
    tokensK: number;
    /** Tasks finished today by these agents. */
    done: number;
    /**
     * 2.3: the chart's slices. Up to 5 agents, highest first, by cost when
     * any run reported one (`cost` is not null), else by runs; `others` holds
     * the rest, so the slices plus `others` add up to `cost` (or to `runs`).
     * Agents with nothing to count (no cost, or no runs) are left out.
     */
    top: LiveTodaySlice[];
    others: { n: number; cost: number; runs: number };
}

export interface LiveTodaySlice {
    agentId: string;
    /** Cents; 0 when the chart is by runs. */
    cost: number;
    runs: number;
}

/** One agent's usage today, as loaded (the per-agent rows `today` is summed from). */
export interface TodayRow {
    agentId: string;
    runs: number;
    tokens: number;
    /** Sum of cost_cents over the runs that reported one. */
    cost: number;
    /** How many runs reported a cost. */
    costed: number;
    done: number;
}

export const TODAY_TOP = 5;

/**
 * Pure: `today` from per-agent rows, counting only `agentIds`. The rows ride
 * along non-enumerably (never serialized) so scopeLiveFeed can re-sum them
 * for a narrower viewer.
 */
export function shapeToday(rows: readonly TodayRow[], agentIds: ReadonlySet<string>): LiveToday {
    const mine = rows.filter((r) => agentIds.has(r.agentId));
    const sum = (pick: (r: TodayRow) => number) => mine.reduce((acc, r) => acc + (Number(pick(r)) || 0), 0);
    const cents = (r: TodayRow) => (r.costed > 0 ? Math.round(r.cost) : 0);
    // By cost only when a whole cent was reported: sub-half-cent costs round to
    // nothing and must read as "no cost" (runs chart), never as $0.00.
    const byCost = mine.some((r) => cents(r) > 0);
    // Slices: by cost when any run reported one, else by runs (never an invented $).
    const ranked = mine.filter((r) => (byCost ? cents(r) > 0 : r.runs > 0))
        .sort((a, b) => (byCost ? cents(b) - cents(a) : b.runs - a.runs) || a.agentId.localeCompare(b.agentId));
    const rest = ranked.slice(TODAY_TOP);
    const today: LiveToday = {
        // The sum of the rounded per-agent costs, so the slices add up exactly.
        cost: byCost ? mine.reduce((acc, r) => acc + cents(r), 0) : null,
        runs: sum((r) => r.runs),
        tokensK: Math.round(sum((r) => r.tokens) / 1000),
        done: sum((r) => r.done),
        top: ranked.slice(0, TODAY_TOP).map((r) => ({ agentId: r.agentId, cost: byCost ? cents(r) : 0, runs: r.runs })),
        others: {
            n: rest.length,
            cost: byCost ? rest.reduce((acc, r) => acc + cents(r), 0) : 0,
            runs: rest.reduce((acc, r) => acc + r.runs, 0),
        },
    };
    return Object.defineProperty(today, "rows", { value: mine, enumerable: false });
}

/** The per-agent rows behind a `today` (see shapeToday), or [] for one built elsewhere. */
function todayRowsOf(today: LiveToday): readonly TodayRow[] {
    return (today as LiveToday & { rows?: readonly TodayRow[] }).rows ?? [];
}

/** UTC offset of `timezone` at `at`, in ms (local wall clock minus UTC). */
function tzOffsetMs(at: Date, timezone: string): number {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((p) => [p.type, p.value]));
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** Pure: the instant of the latest local midnight at or before `now` in `timezone` (UTC when null or invalid). */
export function localMidnight(now: Date, timezone: string | null): Date {
    if (!timezone) return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    try {
        const local = new Date(now.getTime() + tzOffsetMs(now, timezone));
        const wallMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
        // Resolve the offset at midnight itself (DST changes during the day).
        let instant = wallMidnight - tzOffsetMs(new Date(wallMidnight - tzOffsetMs(now, timezone)), timezone);
        if (instant > now.getTime()) instant -= 24 * 60 * 60 * 1000;
        return new Date(instant);
    } catch {
        return localMidnight(now, null);
    }
}

/**
 * Narrow a feed to the agents a restricted viewer may see (the token
 * creator's member scope): agents, their messages, DMs, events and needs, and
 * the agent tallies. Company-wide task/approval totals become 0 for a scoped
 * viewer rather than leaking counts. `agentIds` undefined = unrestricted.
 */
export function scopeLiveFeed(feed: LiveFeed, agentIds: readonly string[] | undefined): LiveFeed {
    if (!agentIds) return feed;
    const allowed = new Set(agentIds);
    const agents = feed.agents.filter((a) => allowed.has(a.id));
    const tally = (status: HealthStatus) => agents.filter((a) => a.health === status).length;
    return {
        ...feed,
        summary: {
            agents: agents.length,
            healthy: tally("healthy"),
            attention: tally("attention"),
            down: tally("down"),
            idle: tally("idle"),
            working: agents.filter((a) => a.state === "typing" || a.state === "working").length,
            pendingApprovals: 0,
            tasksInProgress: 0,
            tasksOverdue: 0,
        },
        agents,
        messages: feed.messages.filter((m) => m.agentId !== null && allowed.has(m.agentId)),
        dm: feed.dm.filter((d) => allowed.has(d.agentId)),
        events: feed.events.filter((e) => allowed.has(e.a) && (!e.b || allowed.has(e.b))),
        needs: feed.needs.filter((n) => allowed.has(n.agentId)),
        ...(feed.today ? { today: shapeToday(todayRowsOf(feed.today), new Set(agents.map((a) => a.id))) } : {}),
    };
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
        agents: feed.agents.map((a) => ({
            ...a, lastSeenSec: undefined, thoughtAgeSec: undefined,
            // The step's identity (non-enumerable `key`: run + event) counts, so a new
            // step with the same label refreshes the device timer; its ticking `sec` does not.
            step: a.step ? { ...a.step, sec: undefined, key: a.step.key } : undefined,
            last: a.last ? { ...a.last, ageSec: undefined } : undefined,
        })),
        messages: feed.messages.map((m) => ({ ...m, ageSec: undefined })),
        dm: (feed.dm ?? []).map((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, ageSec: undefined })) })),
        events: (feed.events ?? []).map((e) => ({ ...e, ageSec: undefined })),
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
 * "An agent's direct chat" is resolved as the app's chat does for the creator
 * (ensureDirectThread in control-plane.ts): in private direct-chat mode, the
 * creator's own thread with the agent (none yet: no `dm`); in shared mode, the
 * agent's shared thread, never anyone's private one. A shared channel is seen
 * by every company member, so the thread as a whole is never sent. Only these
 * messages are:
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
            select distinct on (t.direct_agent_id) t.direct_agent_id as agent_id, t.id as thread_id
              from message_threads t
             where t.company_id = ${companyId}
               and t.type = 'direct'
               and t.archived_at is null
               and t.direct_agent_id is not null
               and case when (select c.direct_chat_mode from companies c where c.id = ${companyId}) = 'private'
                        then t.owner_user_id = ${userId}
                        else not t.is_private and t.owner_user_id is null end
             order by t.direct_agent_id, t.created_at
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

// ─── v2 loaders (each ONE query for the whole company) ─────────────────────

export interface SharedThreadOptions {
    /**
     * Read machine-managed agent pair threads (group threads with the reserved
     * pair marker and a system creator). The device feed treats them as shared;
     * the web dashboard shows them to owners/admins only.
     */
    includePairThreads?: boolean;
}

/** SQL guard that drops agent pair threads when the reader may not see them. */
function sharedThreadFilter(options: SharedThreadOptions) {
    if (options.includePairThreads !== false) return undefined;
    return sql`(${messageThreads.description} is distinct from ${AGENT_PAIR_DESCRIPTION} or ${messageThreads.createdByType} is distinct from 'system')`;
}

/** Only this much of a reasoning transcript (its end: the latest thinking) is read. */
const THOUGHT_SCAN_CHARS = 1500;
/** Per agent, the newest few reasoning rows are read, so a stub can fall back to the one before. */
const THOUGHT_ROWS_PER_AGENT = 3;
const HANDOFF_SCAN_ROWS = 40;
const TRANSITION_SCAN_ROWS = 40;
const PENDING_APPROVAL_ROWS = 20;
const INCIDENT_SCAN_ROWS = 50;

/**
 * The newest reasoning rows per agent from the last 10 minutes, in ONE query.
 * Rows are ranked on light columns first (id, agent, time, thread type) and
 * only the THOUGHT_ROWS_PER_AGENT survivors per agent have their transcript
 * tail read, so large reasoning rows are not detoasted on every poll. Rows
 * come from team/group threads, plus, when `creatorReplyIds` is non-empty
 * (an opted-in screen whose creator is still an admin), exactly those agent
 * replies to the creator that `dm` shows. Other direct chats are never read.
 * Uses thread_message_reasoning_company_created_idx.
 */
export async function loadRecentReasoning(companyId: string, since: Date, creatorReplyIds: readonly string[], options: SharedThreadOptions = {}): Promise<ReasoningRow[]> {
    const shared = sharedThreadFilter(options);
    const visibleThread = creatorReplyIds.length
        ? or(
            inArray(messageThreads.type, [...PUBLIC_THREAD_TYPES]),
            and(eq(messageThreads.type, "direct"), inArray(threadMessages.id, [...creatorReplyIds])),
        )
        : inArray(messageThreads.type, [...PUBLIC_THREAD_TYPES]);
    const ranked = db.select({
        reasoningId: sql<string>`${threadMessageReasoning.id}`.as("ranked_reasoning_id"),
        agentId: sql<string>`${threadMessages.senderId}`.as("ranked_agent_id"),
        messageId: sql<string>`${threadMessages.id}`.as("ranked_message_id"),
        threadType: sql<string>`${messageThreads.type}`.as("ranked_thread_type"),
        ms: sql<string>`extract(epoch from ${threadMessageReasoning.createdAt}) * 1000`.as("ranked_ms"),
        rn: sql<number>`row_number() over (partition by ${threadMessages.senderId} order by ${threadMessageReasoning.createdAt} desc, ${threadMessageReasoning.id} desc)`.as("ranked_rn"),
    }).from(threadMessageReasoning)
        .innerJoin(threadMessages, eq(threadMessages.id, threadMessageReasoning.messageId))
        .innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
        .where(and(
            eq(threadMessageReasoning.companyId, companyId),
            gt(threadMessageReasoning.createdAt, since),
            eq(threadMessages.companyId, companyId),
            eq(threadMessages.senderType, "agent"),
            eq(messageThreads.companyId, companyId),
            isNull(messageThreads.archivedAt),
            visibleThread,
            shared,
        ))
        .as("ranked");
    const rows = await db.select({
        agentId: ranked.agentId,
        messageId: ranked.messageId,
        threadType: ranked.threadType,
        ms: ranked.ms,
        tail: sql<string>`right(${threadMessageReasoning.reasoning}, ${THOUGHT_SCAN_CHARS})`,
        truncated: sql<boolean>`length(${threadMessageReasoning.reasoning}) > ${THOUGHT_SCAN_CHARS}`,
    }).from(ranked)
        .innerJoin(threadMessageReasoning, eq(threadMessageReasoning.id, ranked.reasoningId))
        .where(lte(ranked.rn, THOUGHT_ROWS_PER_AGENT));
    return rows.filter((r) => r.agentId).map((r) => ({
        agentId: r.agentId,
        messageId: r.messageId,
        threadType: r.threadType,
        createdAtMs: Number(r.ms),
        reasoning: r.tail ?? "",
        truncatedHead: r.truncated === true,
    }));
}

/** Agent-authored, non-control messages in shared threads from the window (thread_messages_company_sender_created_idx). */
export function loadRecentAgentMessages(companyId: string, since: Date, options: SharedThreadOptions = {}) {
    return db.select({
        id: threadMessages.id,
        senderId: threadMessages.senderId,
        targetAgentId: threadMessages.targetAgentId,
        text: sql<string>`left(${threadMessages.text}, ${MESSAGE_SCAN_CHARS})`,
        createdAt: threadMessages.createdAt,
    }).from(threadMessages)
        .innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
        .where(and(
            eq(threadMessages.companyId, companyId),
            eq(threadMessages.senderType, "agent"),
            gt(threadMessages.createdAt, since),
            sql`(${threadMessages.metadataJson} -> 'runtimeControl') is null`,
            eq(messageThreads.companyId, companyId),
            inArray(messageThreads.type, [...PUBLIC_THREAD_TYPES]),
            isNull(messageThreads.archivedAt),
            sharedThreadFilter(options),
        ))
        .orderBy(desc(threadMessages.createdAt))
        .limit(HANDOFF_SCAN_ROWS);
}

/** Task transitions to done/blocked in the window (task_events_company_created_idx). */
export function loadRecentTransitions(companyId: string, since: Date) {
    return db.select({
        id: taskEvents.id,
        state: sql<string | null>`coalesce(${taskEvents.payloadJson} ->> 'state', substring(${taskEvents.eventType} from 6))`,
        actorType: taskEvents.actorType,
        actorId: taskEvents.actorId,
        assignedAgentId: tasks.assignedAgentId,
        title: sql<string | null>`${tasks.inputJson}->>'title'`,
        taskType: tasks.taskType,
        createdAt: taskEvents.createdAt,
    }).from(taskEvents)
        .innerJoin(tasks, and(eq(tasks.id, taskEvents.taskId), eq(tasks.companyId, companyId)))
        .where(and(
            eq(taskEvents.companyId, companyId),
            gt(taskEvents.createdAt, since),
            or(
                inArray(taskEvents.eventType, ["task_done", "task_blocked"]),
                and(inArray(taskEvents.eventType, ["task_updated", "task_reassigned"]), sql`${taskEvents.payloadJson} ->> 'state' in ('done', 'blocked')`),
            ),
        ))
        .orderBy(desc(taskEvents.createdAt))
        .limit(TRANSITION_SCAN_ROWS);
}

/**
 * The newest pending approvals, ONE row per approval, with the title of its
 * first linked task (lowest task id), so titles never flip between polls and
 * break the ETag. The limit counts approvals, not join rows.
 */
function loadPendingApprovals(companyId: string) {
    const firstTask = sql<{ title: string | null; taskType: string } | null>`(
        select json_build_object('title', lt.input_json ->> 'title', 'taskType', lt.task_type)
          from approval_task_links l
          join tasks lt on lt.id = l.task_id and lt.company_id = ${companyId}
         where l.approval_id = "approvals"."id"
         order by l.task_id
         limit 1)`;
    return db.select({
        id: approvals.id,
        requesterAgentId: approvals.requesterAgentId,
        actionType: approvals.actionType,
        rationale: sql<string | null>`left(${approvals.rationale}, 300)`,
        requestedAt: approvals.requestedAt,
        task: firstTask,
    }).from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .orderBy(desc(approvals.requestedAt), approvals.id)
        .limit(PENDING_APPROVAL_ROWS);
}

/** Open incidents on agent-assigned tasks (the dashboard's "stuck" source). */
function loadOpenAgentIncidents(companyId: string) {
    return db.select({
        id: incidents.id,
        reasonCode: incidents.reasonCode,
        summary: sql<string>`left(${incidents.summary}, 300)`,
        createdAt: incidents.createdAt,
        taskId: incidents.taskId,
        taskState: tasks.state,
        taskDeletedAt: tasks.deletedAt,
        assignedAgentId: tasks.assignedAgentId,
        title: sql<string | null>`${tasks.inputJson}->>'title'`,
        taskType: tasks.taskType,
    }).from(incidents)
        .innerJoin(tasks, and(eq(tasks.id, incidents.taskId), eq(tasks.companyId, companyId)))
        .where(and(eq(incidents.companyId, companyId), eq(incidents.status, "open"), isNull(incidents.deletedAt), isNotNull(tasks.assignedAgentId)))
        .orderBy(desc(incidents.createdAt))
        .limit(INCIDENT_SCAN_ROWS);
}

/** `last`: how far back a finished task still counts, and its title cap. */
export const LIVE_LAST_DONE_MS = 7 * 24 * 60 * 60 * 1000;
export const LAST_TITLE_MAX = 56;

/**
 * A task_events row that finished a task: `task_done`, or an update or
 * reassignment that set the state to done (the transitions loadRecentTransitions
 * reads). Matches the partial index task_events_completed_idx exactly.
 */
const COMPLETION_EVENT = sql`(e.event_type = 'task_done' OR (e.event_type IN ('task_updated', 'task_reassigned') AND e.payload_json ->> 'state' = 'done'))`;

/** `to_timestamp` of a JS instant as a UTC `timestamp` (columns are timestamp without time zone, in UTC). */
function utcTimestamp(at: Date) {
    return sql`(to_timestamp(${at.getTime()}::double precision / 1000) AT TIME ZONE 'UTC')`;
}

/**
 * Each agent's most recently finished task from the last 7 days, ONE row per
 * agent (DISTINCT ON), in one query for the company. "Finished" is the
 * completion event's time, not tasks.updated_at (an edit to an old done task
 * must not make it look new); the task must still be done and assigned to
 * the agent. Reads task_events_completed_idx.
 */
async function loadLastDoneTasks(companyId: string, now: Date) {
    const result = await db.execute<{ agent_id: string; title: string | null; task_type: string | null; done_ms: number | string }>(sql`
        SELECT DISTINCT ON (tk.assigned_agent_id) tk.assigned_agent_id AS agent_id, tk.input_json ->> 'title' AS title,
               tk.task_type, extract(epoch from e.created_at) * 1000 AS done_ms
          FROM ${taskEvents} e
          JOIN ${tasks} tk ON tk.id = e.task_id AND tk.company_id = ${companyId}
         WHERE e.company_id = ${companyId} AND e.created_at > ${utcTimestamp(new Date(now.getTime() - LIVE_LAST_DONE_MS))}
           AND ${COMPLETION_EVENT}
           AND tk.state = ${TASK_STATES.done} AND tk.deleted_at IS NULL AND tk.assigned_agent_id IS NOT NULL
         ORDER BY tk.assigned_agent_id, e.created_at DESC, e.id DESC`);
    return result.rows.map((r) => ({ agentId: r.agent_id, title: r.title, taskType: r.task_type, doneAt: new Date(Math.round(Number(r.done_ms))) }));
}

/** Pure: `last` for one agent — an ASCII title of at most LAST_TITLE_MAX chars, or undefined. */
export function lastDoneOf(row: { title: string | null; taskType: string | null; doneAt: Date } | undefined, nowMs: number): LiveLast | undefined {
    if (!row) return undefined;
    const title = cleanSnippet(screenAscii(taskTitle({ inputJson: { title: row.title }, taskType: row.taskType })), LAST_TITLE_MAX);
    if (!title) return undefined;
    return { title, ageSec: Math.max(0, Math.floor((nowMs - row.doneAt.getTime()) / 1000)) };
}

/**
 * Each agent's usage since `since` (local midnight) in ONE query: runs,
 * tokens and cost from agent_runs (agent_runs_company_started_idx range) and
 * tasks finished today from their completion events (task_events_completed_idx),
 * one row per agent.
 *
 * Only runs the screen may read count, by the same rule as screenRunVisible
 * (and the same thread join as loadRunThoughtRows): thread-less task runs,
 * team and group threads (agent pair threads included, as on screens), and a
 * direct chat only when it is the viewer's own private chat. `viewerUserId`
 * is set only on an opted-in screen whose creator may show private chats.
 * Other members' chats and the shared Work log never count, so a screen's
 * totals cannot reveal when someone else talks to an agent. A cost counts only
 * when a run reported one (cost_cents > 0); runtimes that report none leave
 * `costed` at 0, so the screen shows "-", not $0.00.
 */
async function loadTodayRows(companyId: string, since: Date, viewerUserId: string | null): Promise<TodayRow[]> {
    const sinceSql = utcTimestamp(since);
    const ownChat = viewerUserId ? sql`(t.is_private AND t.owner_user_id = ${viewerUserId})` : sql`false`;
    const result = await db.execute<{ agent_id: string; runs: number | string | null; tokens: number | string | null; cost: number | string | null; costed: number | string | null; done: number | string | null }>(sql`
        WITH r AS (
            SELECT ar.agent_id, count(*) AS runs,
                   sum(coalesce(ar.input_tokens, 0) + coalesce(ar.output_tokens, 0)) AS tokens,
                   sum(ar.cost_cents) FILTER (WHERE ar.cost_cents > 0) AS cost,
                   count(*) FILTER (WHERE ar.cost_cents > 0) AS costed
              FROM ${agentRuns} ar
              LEFT JOIN ${messageThreads} t ON t.id = ar.thread_id AND t.company_id = ${companyId} AND t.archived_at IS NULL
             WHERE ar.company_id = ${companyId} AND ar.started_at >= ${sinceSql} AND ar.agent_id IS NOT NULL
               AND (ar.thread_id IS NULL OR t.type IN ('team', 'group') OR (t.type = 'direct' AND ${ownChat}))
             GROUP BY ar.agent_id
        ), t AS (
            SELECT tk.assigned_agent_id AS agent_id, count(DISTINCT e.task_id) AS done
              FROM ${taskEvents} e
              JOIN ${tasks} tk ON tk.id = e.task_id AND tk.company_id = ${companyId}
             WHERE e.company_id = ${companyId} AND e.created_at >= ${sinceSql} AND ${COMPLETION_EVENT}
               AND tk.state = ${TASK_STATES.done} AND tk.deleted_at IS NULL AND tk.assigned_agent_id IS NOT NULL
             GROUP BY tk.assigned_agent_id
        )
        SELECT coalesce(r.agent_id, t.agent_id) AS agent_id, r.runs, r.tokens, r.cost, r.costed, t.done
          FROM r FULL JOIN t ON t.agent_id = r.agent_id`);
    return result.rows.map((row) => ({
        agentId: row.agent_id,
        runs: Number(row.runs) || 0,
        tokens: Number(row.tokens) || 0,
        cost: Number(row.cost) || 0,
        costed: Number(row.costed) || 0,
        done: Number(row.done) || 0,
    }));
}

/** The device keeps only this many step texts and last-done titles (its shared pools). */
export const LIVE_MAX_STEP_TEXTS = 6;
export const LIVE_MAX_LASTS = 6;

/**
 * Pure: send `step.text` only for the LIVE_MAX_STEP_TEXTS most recent steps
 * and `last` only for the LIVE_MAX_LASTS most recently finished agents, as
 * many as the device can keep (step labels stay on every agent). Ties keep
 * the feed's agent order. Mutates the agents.
 */
export function capScreenExtras(agents: LiveAgent[]): void {
    const withText = agents.filter((a) => a.step?.text).sort((x, y) => x.step!.sec - y.step!.sec);
    for (const agent of withText.slice(LIVE_MAX_STEP_TEXTS)) delete agent.step!.text;
    const withLast = agents.filter((a) => a.last).sort((x, y) => x.last!.ageSec - y.last!.ageSec);
    for (const agent of withLast.slice(LIVE_MAX_LASTS)) delete agent.last;
}

/** The agent replies to the token creator that `dm` is built from. */
function creatorReplyIdsOf(chats: Awaited<ReturnType<typeof loadPrivateChats>>): string[] {
    return (chats ?? []).flatMap((c) => c.messages.filter((m) => !m.me).map((m) => m.id));
}

const STATE_ORDER: Record<LiveState, number> = { typing: 0, working: 0, idle: 0, offline: 1 };

export async function buildLiveFeed(companyId: string, options: {
    messages?: number;
    now?: Date;
    /** The token creator whose own direct chats the feed may carry (opted-in read_only tokens only). */
    privateChatsUserId?: string | null;
    /** Carry each agent's `thought` (opted-in read_only tokens only). When false, reasoning is never queried. */
    agentThoughts?: boolean;
} = {}): Promise<LiveFeed> {
    const now = options.now ?? new Date();
    const messageLimit = Math.min(LIVE_MAX_MESSAGES, Math.max(0, options.messages ?? LIVE_DEFAULT_MESSAGES));

    const since = new Date(now.getTime() - LIVE_RECENT_MS);
    const privateChatsPromise = loadPrivateChats(companyId, options.privateChatsUserId);
    const companyPromise = db.select({ name: companies.name, agentRoutineJson: companies.agentRoutineJson }).from(companies).where(eq(companies.id, companyId)).limit(1);
    // Today is counted from midnight in the company's timezone (the agent routine's), else UTC.
    // Its runs follow the screen's run visibility (the same viewer as the run rows).
    const todayPromise = Promise.all([companyPromise, privateChatsPromise]).then(([rows, chats]) =>
        loadTodayRows(companyId, localMidnight(now, companyTimezoneFrom(rows[0]?.agentRoutineJson)), options.agentThoughts && chats ? options.privateChatsUserId ?? null : null));
    // Thoughts wait for the private chats: direct rows are filtered to the
    // creator's own replies in SQL, so other DMs never crowd out the top rows.
    const reasoningPromise: Promise<ReasoningRow[]> = options.agentThoughts
        ? privateChatsPromise.then((chats) => loadRecentReasoning(companyId, since, creatorReplyIdsOf(chats)))
        : Promise.resolve([]);
    // Live run steps (0.9 bridges), read like the dashboard with the screen's
    // creator as viewer - only once their private chats are known to be
    // allowed, so a direct chat they take part in counts only on an opted-in
    // screen whose creator is still an admin. Every screen reads them for the
    // generic `step.label`; step text and thoughts stay opt-in. The viewer is
    // only passed on a thoughts token: without it no direct chat is readable.
    const runThoughtPromise: Promise<RunThoughtRow[]> = privateChatsPromise.then((chats) =>
        loadRunThoughtRows(companyId, { now, viewerUserId: options.agentThoughts && chats ? options.privateChatsUserId ?? null : null }));
    const [health, companyRows, taskCounts, agentTasks, approvalCount, typingRows, messageRows, privateChats,
        reasoningRows, runThoughtRows, handoffRows, transitionRows, approvalRows, incidentRows, lastDoneRows, todayRows] = await Promise.all([
        getCachedHealth(companyId, now),
        companyPromise,
        db.select({
            inProgress: sql<number>`count(*) filter (where ${tasks.state} = ${TASK_STATES.inProgress})`,
            overdue: sql<number>`count(*) filter (where ${inArray(tasks.state, [...SLA_TRACKED_TASK_STATES])} and ${lt(tasks.slaDueAt, now)})`,
        }).from(tasks).where(and(eq(tasks.companyId, companyId), isNull(tasks.deletedAt))),
        // Each agent's most relevant in-progress task (and, for `act`, in-review
        // task): highest priority, then most recently touched.
        db.selectDistinctOn([tasks.assignedAgentId, tasks.state], {
            id: tasks.id,
            agentId: tasks.assignedAgentId,
            state: tasks.state,
            title: sql<string | null>`${tasks.inputJson}->>'title'`,
            taskType: tasks.taskType,
        }).from(tasks)
            .where(and(
                eq(tasks.companyId, companyId),
                isNull(tasks.deletedAt),
                inArray(tasks.state, [TASK_STATES.inProgress, TASK_STATES.review]),
                sql`${tasks.assignedAgentId} is not null`,
            ))
            .orderBy(tasks.assignedAgentId, tasks.state, desc(tasks.priority), desc(tasks.updatedAt)),
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
        privateChatsPromise,
        reasoningPromise,
        runThoughtPromise,
        loadRecentAgentMessages(companyId, since),
        loadRecentTransitions(companyId, since),
        loadPendingApprovals(companyId),
        loadOpenAgentIncidents(companyId),
        loadLastDoneTasks(companyId, now),
        todayPromise,
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
    const taskByAgent = new Map(agentTasks.filter((t) => t.agentId && t.state === TASK_STATES.inProgress).map((t) => [t.agentId!, t]));
    const reviewByAgent = new Map(agentTasks.filter((t) => t.agentId && t.state === TASK_STATES.review).map((t) => [t.agentId!, t]));
    const titleOf = (t: { title: string | null; taskType: string | null }) => taskTitle({ inputJson: { title: t.title }, taskType: t.taskType });

    // v2 inputs.
    const pending: PendingApprovalRow[] = [];
    for (const a of approvalRows) {
        const task = a.task ? titleOf({ title: a.task.title, taskType: a.task.taskType }) : null;
        pending.push({ id: a.id, requesterAgentId: a.requesterAgentId, title: approvalTitle({ actionType: a.actionType, rationale: a.rationale, taskTitle: task }), requestedAtMs: a.requestedAt.getTime() });
    }
    const approvalByAgent = new Map<string, { id: string; title: string }>();
    for (const a of pending) if (a.requesterAgentId && !approvalByAgent.has(a.requesterAgentId)) approvalByAgent.set(a.requesterAgentId, { id: a.id, title: a.title });
    const incidentByAgent = new Map<string, { id: string; taskId: string | null; title: string; reason: string }>();
    for (const i of incidentRows) {
        if (!i.assignedAgentId || incidentByAgent.has(i.assignedAgentId)) continue;
        if (!isLiveProblemIncident({ reasonCode: i.reasonCode, summary: i.summary, taskState: i.taskState, taskDeleted: i.taskDeletedAt !== null, createdAt: i.createdAt })) continue;
        incidentByAgent.set(i.assignedAgentId, { id: i.id, taskId: i.taskId, title: titleOf(i), reason: i.reasonCode.replace(/_/g, " ") });
    }
    const knownAgents = new Set(health.agents.map((a) => a.id));
    const transitions = transitionRows.map((r) => ({
        id: r.id, state: r.state ?? "", actorType: r.actorType, actorId: r.actorId, assignedAgentId: r.assignedAgentId,
        title: titleOf(r), createdAtMs: r.createdAt.getTime(),
    }));
    const justDone = recentlyDoneAgents(transitions, knownAgents, now.getTime());

    const scored = health.agents.map((a) => ({ a, live: typing.get(a.id), status: scoreAgent({ ...a, online: Boolean(typing.get(a.id)) || a.online }).status }));
    const acts = deriveActs(scored.map(({ a, live, status }) => {
        const task = taskByAgent.get(a.id);
        const review = reviewByAgent.get(a.id);
        return {
            id: a.id,
            name: a.name,
            health: status,
            activity: live?.activity ?? null,
            working: task ? [{ id: task.id, title: titleOf(task), taskType: task.taskType }] : [],
            waiting: review ? [{ id: review.id, title: titleOf(review), taskType: review.taskType }] : [],
            incident: incidentByAgent.get(a.id) ?? null,
            approval: approvalByAgent.get(a.id) ?? null,
            justDone: justDone.has(a.id),
        };
    }));

    const all: LiveAgent[] = scored.map(({ a, live, status }) => {
        const task = taskByAgent.get(a.id);
        const lastSeenMs = a.lastSeenAt ? Date.parse(a.lastSeenAt) : NaN;
        const act = acts.get(a.id) ?? { act: "idle" as const, mood: "neutral" as const };
        return {
            id: a.id,
            name: a.name,
            short: shortName(a.name),
            hue: agentHue(a.id, a),
            health: status,
            state: deriveLiveState({ typing: Boolean(live), online: a.online, hasTaskInProgress: Boolean(task) }),
            activity: live?.activity ? toPlainText(live.activity, ACTIVITY_MAX) || null : null,
            task: task ? { id: task.id, title: cleanSnippet(taskTitle({ inputJson: { title: task.title }, taskType: task.taskType }), TASK_TITLE_MAX) } : null,
            lastSeenSec: Number.isFinite(lastSeenMs) ? Math.max(0, Math.floor((now.getTime() - lastSeenMs) / 1000)) : null,
            unanswered: a.unanswered,
            look: packLook(resolveAppearance({ id: a.id, avatarUrl: a.avatarUrl, avatarAppearance: a.avatarAppearance })),
            act: act.act,
            mood: act.mood,
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
    const shownIds = new Set(shown.map((a) => a.id));
    const dm = privateChats ? shapeDm(privateChats, shownIds, now.getTime()) : [];

    // Thoughts: shared threads, plus - only on an opted-in screen whose creator
    // is still an admin (privateChats non-null) - the agent's replies to the
    // creator that `dm` is built from. Never another member's direct chat.
    const creatorReplyIds = new Set(creatorReplyIdsOf(privateChats));
    const thoughts = pickThoughts(reasoningRows.filter((r) => shownIds.has(r.agentId)), { nowMs: now.getTime(), creatorReplyIds });
    // A live run step wins over legacy reasoning, as on the dashboard. Pair
    // threads stay readable here, as they always were for legacy reasoning.
    const shownRuns = runThoughtRows.filter((r) => shownIds.has(r.agentId));
    const runThoughts = options.agentThoughts
        ? screenThoughtsFromRuns(shownRuns, { nowMs: now.getTime(), includePairThreads: true })
        : new Map<string, { thought: string; ageSec: number }>();
    // Steps: a generic label for every screen; the real text only where the
    // thought could be shown too (same token opt-in and run visibility).
    const steps = screenStepsFromRuns(shownRuns, { nowMs: now.getTime(), includePairThreads: true, allowText: options.agentThoughts === true });
    const lastDoneByAgent = new Map(lastDoneRows.filter((r) => r.agentId).map((r) => [r.agentId!, r]));
    for (const agent of shown) {
        // An offline agent's `running` run is a leftover (a crashed bridge), not live work.
        const offline = agent.state === "offline";
        const t = (offline ? undefined : runThoughts.get(agent.id)) ?? thoughts.get(agent.id);
        if (t) {
            agent.thought = t.thought;
            agent.thoughtAgeSec = t.ageSec;
        }
        const step = offline ? undefined : steps.get(agent.id);
        if (step) agent.step = step;
        if (agent.state === "idle" || offline) {
            const last = lastDoneOf(lastDoneByAgent.get(agent.id), now.getTime());
            if (last) agent.last = last;
        }
    }
    capScreenExtras(shown);

    const events = deriveEvents({
        handoffs: handoffRows.map((m) => ({ id: m.id, senderId: m.senderId, targetAgentId: m.targetAgentId, text: m.text ?? "", createdAtMs: m.createdAt.getTime() })),
        transitions,
        approvals: pending,
        roster: health.agents.map((a) => ({ id: a.id, name: a.name })),
        shown: shownIds,
        nowMs: now.getTime(),
    });
    const needs = deriveNeeds(pending);

    const tally = (status: HealthStatus) => all.filter((a) => a.health === status).length;
    const feed: LiveFeed = {
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
        events,
        needs,
        today: shapeToday(todayRows, shownIds),
    };
    return fitThoughtsToBudget(feed);
}
