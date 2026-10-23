import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRunDaily, agentRunEvents, agentRuns, agents, messageRoutes, messageThreads, threadMessages } from "@/db/schema";
import { RUN_STATUSES } from "@/lib/run-ledger";
import { liveUsageFromData, loadLiveRuns, type RunLive, type RunLiveUsage } from "@/lib/run-events";
import { loadThreadVisibility, redactRunForViewer } from "@/lib/agent-activity";
import type { TimelineStep } from "@/lib/live-activity";
import { userMayUseThread } from "@/lib/direct-chat-mode";

/**
 * Read side of the run ledger, used by the delivery inspector and the Agent →
 * Runs tab (PR 4). Kept as plain loaders so they are testable without a browser
 * session; every query is company-scoped by the caller.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runs per page on the Agent → Runs tab. */
export const RUNS_PAGE_SIZE = 50;
/** How many days of daily rollups the Runs tab charts. */
export const RUN_DAILY_WINDOW_DAYS = 30;

export interface MessageDeliveryVerdict {
    agentId: string;
    agentName: string | null;
    addressed: boolean;
    routeReason: string;
    agentStreak: number;
    maxTurns: number;
    decidedAt: Date;
}

export interface MessageDeliveryView {
    message: {
        id: string;
        threadId: string;
        senderType: string;
        targetAgentId: string | null;
        deliveryState: string;
        createdAt: Date;
    };
    verdicts: MessageDeliveryVerdict[];
    runs: ((typeof agentRuns.$inferSelect) & { eventsCount: number })[];
    /** Queued messages a coalesced reply to this one also answered (§4.5). */
    coalescedMessageIds: string[];
    /** When this message was answered together with another one: that message's id. */
    coalescedInto: string | null;
}

/**
 * Every stored verdict for a message, plus the runs it triggered. A message in
 * a private direct thread the viewer may not use reads as missing (null).
 */
export async function loadMessageDelivery(companyId: string, messageId: string, viewerUserId: string | null = null): Promise<MessageDeliveryView | null> {
    const [message] = await db
        .select({
            id: threadMessages.id,
            threadId: threadMessages.threadId,
            senderType: threadMessages.senderType,
            targetAgentId: threadMessages.targetAgentId,
            deliveryState: threadMessages.deliveryState,
            createdAt: threadMessages.createdAt,
            coalescedInto: sql<string | null>`${threadMessages.metadataJson}->>'coalescedIntoMessageId'`,
            threadType: messageThreads.type,
            threadOwnerUserId: messageThreads.ownerUserId,
            threadIsPrivate: messageThreads.isPrivate,
        })
        .from(threadMessages)
        .innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
        .where(and(eq(threadMessages.id, messageId), eq(threadMessages.companyId, companyId)))
        .limit(1);
    if (!message) return null;
    const { coalescedInto, threadType, threadOwnerUserId, threadIsPrivate, ...messageView } = message;
    if (!userMayUseThread({ type: threadType, ownerUserId: threadOwnerUserId, isPrivate: threadIsPrivate }, viewerUserId)) return null;

    const verdicts = await db
        .select({
            agentId: messageRoutes.agentId,
            agentName: agents.name,
            addressed: messageRoutes.addressed,
            routeReason: messageRoutes.routeReason,
            agentStreak: messageRoutes.agentStreak,
            maxTurns: messageRoutes.maxTurns,
            decidedAt: messageRoutes.decidedAt,
        })
        .from(messageRoutes)
        .leftJoin(agents, eq(agents.id, messageRoutes.agentId))
        .where(and(eq(messageRoutes.companyId, companyId), eq(messageRoutes.messageId, messageId)))
        .orderBy(asc(messageRoutes.decidedAt));

    const runs = await db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.companyId, companyId), eq(agentRuns.triggerMessageId, messageId)))
        .orderBy(desc(agentRuns.startedAt));

    const counts = runs.length === 0 ? [] : await db
        .select({ runId: agentRunEvents.runId, count: sql<number>`count(*)::int` })
        .from(agentRunEvents)
        .where(and(eq(agentRunEvents.companyId, companyId), inArray(agentRunEvents.runId, runs.map((run) => run.id))))
        .groupBy(agentRunEvents.runId);
    const countByRun = new Map(counts.map((row) => [row.runId, Number(row.count)]));

    const coalesced = await db
        .select({ id: threadMessages.id })
        .from(threadMessages)
        .where(and(
            eq(threadMessages.companyId, companyId),
            eq(threadMessages.threadId, message.threadId),
            sql`${threadMessages.metadataJson}->>'coalescedIntoMessageId' = ${messageId}`,
        ))
        .orderBy(asc(threadMessages.createdAt))
        .limit(20);

    return {
        message: messageView,
        verdicts,
        runs: runs.map((run) => ({ ...run, eventsCount: countByRun.get(run.id) ?? 0 })),
        coalescedMessageIds: coalesced.map((row) => row.id),
        coalescedInto: coalescedInto && UUID_RE.test(coalescedInto) ? coalescedInto : null,
    };
}

export interface AgentRunsPage {
    runs: AgentRunWithThread[];
    nextCursor: string | null;
    daily: (typeof agentRunDaily.$inferSelect)[];
}

/**
 * A run plus its triggering thread's type. The type rides along so the Runs tab
 * links only where the messaging hub can honour the deep link: `?group=` opens a
 * group thread, `?agent=` opens a direct one; anything else is plain text.
 */
export type AgentRunWithThread = (typeof agentRuns.$inferSelect) & { threadType: string | null };

/** Keyset cursor: the last run's start instant plus its id for tie-breaking. */
export function encodeRunsCursor(run: { startedAt: Date; id: string }): string {
    return `${run.startedAt.toISOString()}|${run.id}`;
}

export function parseRunsCursor(cursor: string): { startedAt: Date; id: string } | null {
    const separator = cursor.lastIndexOf("|");
    if (separator <= 0) return null;
    const iso = cursor.slice(0, separator);
    const id = cursor.slice(separator + 1);
    const startedAt = new Date(iso);
    // A non-UUID id would reach Postgres as a malformed uuid comparison and raise
    // 22P02; treat any malformed cursor as "no cursor" so the loader never 500s.
    if (!UUID_RE.test(id) || Number.isNaN(startedAt.getTime())) return null;
    return { startedAt, id };
}

/** One page of an agent's runs (newest first) plus its 30-day rollup window. */
export async function loadAgentRunsPage(
    companyId: string,
    agentId: string,
    options: {
        cursor?: string | null;
        status?: string | null;
        now?: Date;
        /**
         * When set (a signed-in viewer, or null for none), runs from private
         * threads the viewer is not part of lose their thread id and raw error,
         * like the Right now card. Undefined keeps the rows unredacted.
         */
        viewerUserId?: string | null;
    } = {},
): Promise<AgentRunsPage> {
    const now = options.now ?? new Date();
    const statusFilter = options.status && (RUN_STATUSES as readonly string[]).includes(options.status)
        ? options.status
        : null;

    const ranges = [eq(agentRuns.companyId, companyId), eq(agentRuns.agentId, agentId)];
    if (statusFilter) ranges.push(eq(agentRuns.status, statusFilter));
    const cursor = options.cursor ? parseRunsCursor(options.cursor) : null;
    if (cursor) {
        const keyset = or(
            lt(agentRuns.startedAt, cursor.startedAt),
            and(eq(agentRuns.startedAt, cursor.startedAt), lt(agentRuns.id, cursor.id)),
        );
        if (keyset) ranges.push(keyset);
    }

    const rows = await db
        .select({ run: agentRuns, threadType: messageThreads.type })
        .from(agentRuns)
        .leftJoin(messageThreads, eq(messageThreads.id, agentRuns.threadId))
        .where(and(...ranges))
        .orderBy(desc(agentRuns.startedAt), desc(agentRuns.id))
        .limit(RUNS_PAGE_SIZE + 1);

    let all: AgentRunWithThread[] = rows.map((row) => ({ ...row.run, threadType: row.threadType }));
    if (options.viewerUserId !== undefined) {
        const { visible } = await loadThreadVisibility(companyId, all.map((run) => run.threadId), options.viewerUserId);
        all = all.map((run) => {
            if (visible(run.threadId)) return run;
            return { ...redactRunForViewer(run, false), threadType: null };
        });
    }
    const hasMore = all.length > RUNS_PAGE_SIZE;
    const runs = hasMore ? all.slice(0, RUNS_PAGE_SIZE) : all;
    const last = runs[runs.length - 1];
    const nextCursor = hasMore && last ? encodeRunsCursor(last) : null;

    // The chart's 30-day window and this cutoff are both UTC calendar days so a
    // rollup written for a UTC day lands in the same bucket the chart draws.
    const dailyCutoff = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - (RUN_DAILY_WINDOW_DAYS - 1),
    )).toISOString().slice(0, 10);
    const daily = await db
        .select()
        .from(agentRunDaily)
        .where(and(
            eq(agentRunDaily.companyId, companyId),
            eq(agentRunDaily.agentId, agentId),
            sql`${agentRunDaily.day} >= ${dailyCutoff}::date`,
        ))
        .orderBy(asc(agentRunDaily.day));

    return { runs, nextCursor, daily };
}

// ─── Chat run state (§4.7) ──────────────────────────────────────────────────

/** The reply-bubble footer of one agent message: the run that produced it. */
export interface ReplyRunSummary {
    runId: string;
    status: string;
    durationMs: number | null;
    toolCalls: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    model: string | null;
}

/** Finished runs re-sent to chat this long after they end (see loadChatRunState). */
export const REPLY_RUN_RECENT_MS = 120_000;
/**
 * A reply's run starts before the reply is posted; runs older than the oldest
 * reply on the page minus this margin are never read. Generous: the lost-run
 * closer gives up on a run after 2 h.
 */
export const REPLY_RUN_START_MARGIN_MS = 6 * 60 * 60 * 1000;

export interface ChatRunState {
    liveRuns: RunLive[];
    /** Agent message id → the run whose reply it is. */
    replyRuns: Record<string, ReplyRunSummary>;
}

/**
 * What `/api/chat` adds for a thread the caller may already read: its live
 * runs (running or ended < 60 s ago, `eventsSince`-aware) and the runs behind
 * the agent replies on the page. A failure here (e.g. the 0.9 migration not
 * applied yet) degrades to empty: chat must keep working.
 */
export async function loadChatRunState(
    companyId: string,
    threadId: string,
    options: { replyMessageIds?: readonly string[]; since?: Map<string, number>; now?: Date } = {},
): Promise<ChatRunState> {
    const replyIds = (options.replyMessageIds ?? []).filter((id) => UUID_RE.test(id)).slice(0, 200);
    const now = options.now ?? new Date();
    const recentlyEnded = new Date(now.getTime() - REPLY_RUN_RECENT_MS);
    // Lower bound on started_at (served by agent_runs_thread_started_idx): the
    // oldest reply on the page minus a margin, and never later than the window
    // the "recently ended" branch needs.
    let startedAfter = new Date(now.getTime() - 2 * REPLY_RUN_START_MARGIN_MS);
    if (replyIds.length > 0) {
        const [oldest] = await db
            .select({ createdAt: sql<string | null>`to_char(min(${threadMessages.createdAt}), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` })
            .from(threadMessages)
            .where(and(eq(threadMessages.companyId, companyId), eq(threadMessages.threadId, threadId), inArray(threadMessages.id, replyIds)))
            .catch(() => [{ createdAt: null }]);
        if (oldest?.createdAt) {
            const bound = new Date(Date.parse(oldest.createdAt) - REPLY_RUN_START_MARGIN_MS);
            if (bound < startedAfter) startedAfter = bound;
        }
    }
    const [liveRuns, replyRows] = await Promise.all([
        loadLiveRuns(companyId, threadId, { since: options.since, now: options.now }).catch((error) => {
            console.error("[chat] live runs unavailable:", error);
            return [] as RunLive[];
        }),
        db
            .select({
                runId: agentRuns.id,
                replyMessageId: agentRuns.replyMessageId,
                status: agentRuns.status,
                durationMs: agentRuns.durationMs,
                toolCalls: agentRuns.toolCalls,
                inputTokens: agentRuns.inputTokens,
                outputTokens: agentRuns.outputTokens,
                model: agentRuns.model,
            })
            .from(agentRuns)
            .where(and(
                eq(agentRuns.companyId, companyId),
                eq(agentRuns.threadId, threadId),
                isNotNull(agentRuns.replyMessageId),
                gte(agentRuns.startedAt, startedAfter),
                // The page's replies, plus runs that finished in the last two
                // minutes: an incremental poll fetched their reply before the
                // run's finish (and its usage) landed.
                replyIds.length > 0
                    ? or(inArray(agentRuns.replyMessageId, replyIds), gt(agentRuns.endedAt, recentlyEnded))
                    : gt(agentRuns.endedAt, recentlyEnded),
            ))
            .limit(250)
            .orderBy(desc(agentRuns.startedAt))
            .catch((error) => {
                console.error("[chat] reply runs unavailable:", error);
                return [];
            }),
    ]);
    const replyRuns: Record<string, ReplyRunSummary> = {};
    for (const row of replyRows) {
        if (!row.replyMessageId || replyRuns[row.replyMessageId]) continue;
        replyRuns[row.replyMessageId] = {
            runId: row.runId,
            status: row.status,
            durationMs: row.durationMs,
            toolCalls: row.toolCalls,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            model: row.model,
        };
    }
    return { liveRuns, replyRuns };
}

// ─── Run timeline (GET /api/runs/[runId]/events) ────────────────────────────

/** Event kinds the full timeline shows (live `steps` plus notices and turn ends). */
export const TIMELINE_EVENT_KINDS = [
    "tool.prepare", "tool.start", "tool.end", "reasoning", "notice", "compaction.start", "compaction.end",
    "subagent.start", "subagent.end", "approval.auto", "clarify.auto", "turn.failed", "turn.interrupted",
] as const;
/** Newest events returned for one run. */
export const RUN_TIMELINE_MAX_EVENTS = 400;

export interface RunTimelineView {
    run: {
        id: string;
        agentId: string | null;
        status: string;
        startedAt: string;
        endedAt: string | null;
        durationMs: number | null;
        inputTokens: number | null;
        outputTokens: number | null;
        cacheReadTokens: number | null;
        cacheWriteTokens: number | null;
        reasoningTokens: number | null;
        costCents: number | null;
        toolCalls: number | null;
        model: string | null;
        provider: string | null;
        exitReason: string | null;
        queueMs: number | null;
        firstTokenMs: number | null;
        compactions: number | null;
        eventsDropped: number | null;
        error: string | null;
        threadId: string | null;
    };
    steps: TimelineStep[];
    /** Newest `usage` event, when the runtime streams usage. */
    usage: (RunLiveUsage & { costUsd: number | null }) | null;
    /** True when the run's thread is private to others: summaries are withheld. */
    redacted: boolean;
}

/**
 * One run's timeline for a signed-in viewer. Company-scoped, restricted to
 * `agentIds` when the viewer has a member scope (null = not found). A run in
 * a private thread the viewer is not part of is redacted like the Right now
 * card: no thread id, a generic error, and no step summaries (tool names,
 * statuses and durations stay).
 */
export async function loadRunTimeline(
    companyId: string,
    runId: string,
    options: { viewerUserId: string | null; agentIds?: readonly string[] },
): Promise<RunTimelineView | null> {
    if (!UUID_RE.test(runId)) return null;
    const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.companyId, companyId), eq(agentRuns.id, runId))).limit(1);
    if (!run) return null;
    if (options.agentIds && (!run.agentId || !options.agentIds.includes(run.agentId))) return null;

    const { visible } = await loadThreadVisibility(companyId, [run.threadId], options.viewerUserId);
    const isVisible = visible(run.threadId);

    const rows = await db
        .select({
            seq: agentRunEvents.seq,
            tsMs: sql<string>`extract(epoch from ${agentRunEvents.ts}) * 1000`,
            kind: agentRunEvents.kind,
            toolName: agentRunEvents.toolName,
            toolCallId: agentRunEvents.toolCallId,
            status: agentRunEvents.status,
            durationMs: agentRunEvents.durationMs,
            summary: agentRunEvents.summary,
        })
        .from(agentRunEvents)
        .where(and(
            eq(agentRunEvents.companyId, companyId),
            eq(agentRunEvents.runId, runId),
            inArray(agentRunEvents.kind, [...TIMELINE_EVENT_KINDS]),
        ))
        .orderBy(desc(agentRunEvents.seq))
        .limit(RUN_TIMELINE_MAX_EVENTS);

    const [usageRow] = await db
        .select({ data: agentRunEvents.data })
        .from(agentRunEvents)
        .where(and(eq(agentRunEvents.companyId, companyId), eq(agentRunEvents.runId, runId), eq(agentRunEvents.kind, "usage")))
        .orderBy(desc(agentRunEvents.seq))
        .limit(1);
    const liveUsage = usageRow ? liveUsageFromData(usageRow.data) : null;
    const costUsd = usageRow && usageRow.data && typeof usageRow.data === "object"
        ? (usageRow.data as Record<string, unknown>).costUsd
        : null;

    const steps: TimelineStep[] = rows.reverse().map((row) => ({
        seq: Number(row.seq),
        ts: new Date(Math.round(Number(row.tsMs))).toISOString(),
        kind: row.kind,
        ...(row.toolName ? { toolName: row.toolName } : {}),
        ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
        ...(row.status ? { status: row.status } : {}),
        ...(row.durationMs != null ? { durationMs: row.durationMs } : {}),
        ...(row.summary && isVisible ? { summary: row.summary } : {}),
    }));

    const redactedRun = redactRunForViewer({ threadId: run.threadId, error: run.error }, isVisible);
    return {
        run: {
            id: run.id,
            agentId: run.agentId,
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            endedAt: run.endedAt?.toISOString() ?? null,
            durationMs: run.durationMs,
            inputTokens: run.inputTokens,
            outputTokens: run.outputTokens,
            cacheReadTokens: run.cacheReadTokens,
            cacheWriteTokens: run.cacheWriteTokens,
            reasoningTokens: run.reasoningTokens,
            costCents: run.costCents,
            toolCalls: run.toolCalls,
            model: run.model,
            provider: run.provider,
            exitReason: run.exitReason,
            queueMs: run.queueMs,
            firstTokenMs: run.firstTokenMs,
            compactions: run.compactions,
            eventsDropped: run.eventsDropped,
            error: redactedRun.error ?? null,
            threadId: redactedRun.threadId,
        },
        steps,
        usage: liveUsage ? { ...liveUsage, costUsd: typeof costUsd === "number" && Number.isFinite(costUsd) ? costUsd : null } : null,
        redacted: !isVisible,
    };
}
