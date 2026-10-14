import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRunDaily, agentRuns, agents, messageRoutes, messageThreads, threadMessages } from "@/db/schema";
import { RUN_STATUSES } from "@/lib/run-ledger";

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
    runs: (typeof agentRuns.$inferSelect)[];
}

/** Every stored verdict for a message, plus the runs it triggered. */
export async function loadMessageDelivery(companyId: string, messageId: string): Promise<MessageDeliveryView | null> {
    const [message] = await db
        .select({
            id: threadMessages.id,
            threadId: threadMessages.threadId,
            senderType: threadMessages.senderType,
            targetAgentId: threadMessages.targetAgentId,
            deliveryState: threadMessages.deliveryState,
            createdAt: threadMessages.createdAt,
        })
        .from(threadMessages)
        .where(and(eq(threadMessages.id, messageId), eq(threadMessages.companyId, companyId)))
        .limit(1);
    if (!message) return null;

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

    return { message, verdicts, runs };
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
    options: { cursor?: string | null; status?: string | null; now?: Date } = {},
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

    const all = rows.map((row) => ({ ...row.run, threadType: row.threadType }));
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
