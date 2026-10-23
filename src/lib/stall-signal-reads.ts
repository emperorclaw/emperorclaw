import { sql } from "drizzle-orm";
import { db } from "@/db";
import { stallSignal, STALL_THRESHOLD_MS, USEFUL_RUN_EVENT_KINDS, type StallSignal } from "@/lib/stall-signal";

/**
 * Stall readings for running runs (slice 10.6). For each run: when it last did
 * something useful (see stall-signal.ts) and how long ago that was.
 *
 * The inbox's attention builder can call this once per request:
 *
 *   const stalls = await loadStallSignals(companyId, { agentIds, onlyStalled: true });
 *
 * Company-scoped; `taskIds` / `agentIds` narrow it (a restricted member passes
 * their agent scope). Thread ids are returned raw: a caller showing them to a
 * person must apply thread visibility (agent-activity.loadThreadVisibility).
 */

export interface RunStallSignal extends StallSignal {
    runId: string;
    agentId: string | null;
    taskId: string | null;
    threadId: string | null;
    startedAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidArray(ids: readonly string[]) {
    return sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;
}

export async function loadStallSignals(
    companyId: string,
    options: {
        taskIds?: readonly string[];
        agentIds?: readonly string[];
        runIds?: readonly string[];
        now?: Date;
        thresholdMs?: number;
        onlyStalled?: boolean;
        limit?: number;
    } = {},
): Promise<RunStallSignal[]> {
    const filters = [sql`r.company_id = ${companyId}::uuid`, sql`r.status = 'running'`];
    for (const [column, ids] of [["task_id", options.taskIds], ["agent_id", options.agentIds], ["id", options.runIds]] as const) {
        if (ids === undefined) continue;
        const valid = ids.filter((id) => UUID_RE.test(id));
        if (valid.length === 0) return [];
        filters.push(sql`r.${sql.raw(column)} = ANY(${uuidArray(valid)})`);
    }
    const usefulKinds = sql.join(USEFUL_RUN_EVENT_KINDS.map((kind) => sql`${kind}`), sql`, `);
    const limit = Math.max(1, Math.min(options.limit ?? 200, 500));

    // Epoch millis keep the process timezone out of it (timestamps are stored as UTC).
    const result = await db.execute<{
        id: string; agent_id: string | null; task_id: string | null; thread_id: string | null;
        started_ms: string | number; event_ms: string | number | null; task_event_ms: string | number | null;
        message_ms: string | number | null; approval_ms: string | number | null;
    }>(sql`
        SELECT r.id, r.agent_id, r.task_id, r.thread_id,
            extract(epoch from r.started_at) * 1000 AS started_ms,
            (SELECT extract(epoch from max(e.ts)) * 1000 FROM agent_run_events e
                WHERE e.run_id = r.id AND e.company_id = r.company_id AND e.kind IN (${usefulKinds})) AS event_ms,
            (SELECT extract(epoch from max(te.created_at)) * 1000 FROM task_events te
                WHERE r.task_id IS NOT NULL AND te.company_id = r.company_id AND te.task_id = r.task_id
                  AND te.actor_type = 'agent' AND te.actor_id = r.agent_id AND te.created_at >= r.started_at) AS task_event_ms,
            (SELECT extract(epoch from max(m.created_at)) * 1000 FROM thread_messages m
                WHERE r.agent_id IS NOT NULL AND m.company_id = r.company_id AND m.sender_type = 'agent'
                  AND m.sender_id = r.agent_id::text AND m.created_at >= r.started_at) AS message_ms,
            (SELECT extract(epoch from max(a.requested_at)) * 1000 FROM approvals a
                WHERE r.agent_id IS NOT NULL AND a.company_id = r.company_id AND a.requester_agent_id = r.agent_id
                  AND a.requested_at >= r.started_at) AS approval_ms
        FROM agent_runs r
        WHERE ${sql.join(filters, sql` AND `)}
        ORDER BY r.started_at DESC
        LIMIT ${limit}`);

    const now = options.now ?? new Date();
    const out: RunStallSignal[] = [];
    for (const row of result.rows) {
        const startedMs = Math.round(Number(row.started_ms));
        const candidates = [row.event_ms, row.task_event_ms, row.message_ms, row.approval_ms]
            .map((value) => (value == null ? null : Math.round(Number(value))))
            .filter((value): value is number => value != null && Number.isFinite(value));
        const last = Math.max(startedMs, ...candidates);
        const signal = stallSignal({ status: "running", lastUsefulAt: last, now, thresholdMs: options.thresholdMs ?? STALL_THRESHOLD_MS });
        if (!signal) continue;
        if (options.onlyStalled && !signal.stalled) continue;
        out.push({
            ...signal,
            runId: row.id,
            agentId: row.agent_id,
            taskId: row.task_id,
            threadId: row.thread_id,
            startedAt: new Date(startedMs).toISOString(),
        });
    }
    return out;
}
