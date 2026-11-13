/**
 * Idle auto-archive of extra private chats (docs/design/multi-chat-per-agent.md
 * §5.3). Runs as a step of the hourly retention job (lib/retention.ts).
 *
 * For every company with multiple chats on, private direct chats and an idle
 * window (`multi_chat_idle_archive_days`, NULL = never), an extra chat
 * (is_main = false) whose last activity — max(last message, creation, last
 * restore) — is older than the window is archived with archive_reason = 'idle'. Only chats
 * that could be restored are archived: restore is refused while the setting is
 * off or the company is in shared mode, so those companies are skipped.
 *
 * Never archived:
 * - a main chat;
 * - a chat with a running run (agent_runs.status = 'running');
 * - a chat with open work (a message in queued / seen / acting);
 * - the chat holding the agent's objective while it can still run
 *   (agent_objectives.thread_id, status active / blocked / paused);
 * - a chat with a pending approval card (approvals.thread_id, status pending).
 *
 * Set-based and bounded: one UPDATE per batch of IDLE_ARCHIVE_BATCH chats, at
 * most IDLE_ARCHIVE_MAX_BATCHES batches per run. Each batch try-locks the same
 * per-(person, agent) advisory lock as create / archive / restore
 * (lockPrivateChats), so a chat whose owner is changing their chats right now
 * is skipped and retried on the next run. A second statement in the same
 * transaction (a fresh snapshot) puts back any chat that received a message or
 * new work while the UPDATE ran, so a chat that just got a message is not left
 * archived.
 *
 * Audit: ONE `company.idle_chats_archived` row per company per run, with the
 * count only (never titles or content), and only when the count is above zero.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { recordAudits, SYSTEM_ACTOR } from "@/lib/audit";
import { MULTI_CHAT_DEFAULTS, MULTI_CHAT_IDLE_DAYS_RANGE } from "@/lib/multi-chat";

/** Chats archived per statement. */
export const IDLE_ARCHIVE_BATCH = 500;
/** Batches per run; what is left waits for the next run. */
export const IDLE_ARCHIVE_MAX_BATCHES = 10;

/** The idle cutoff of company `c` at `now` (out-of-range values read as the default, like normalizeMultiChatSettings). */
function cutoffOf(now: string): SQL {
    const { min, max } = MULTI_CHAT_IDLE_DAYS_RANGE;
    return sql`(${now}::timestamp - make_interval(days => CASE
        WHEN c.multi_chat_idle_archive_days BETWEEN ${min} AND ${max} THEN c.multi_chat_idle_archive_days
        ELSE ${MULTI_CHAT_DEFAULTS.idleArchiveDays} END))`;
}

/** Something in chat `t` keeps it open (company_id first: thread_messages_thread_created_idx) (cutoff given): recent message, open work, a running run, a live objective, a pending approval. */
function keepsChatOpen(cutoff: SQL): SQL {
    return sql`(
        EXISTS (SELECT 1 FROM thread_messages m WHERE m.company_id = t.company_id AND m.thread_id = t.id AND m.created_at >= ${cutoff})
        OR EXISTS (SELECT 1 FROM thread_messages m WHERE m.company_id = t.company_id AND m.thread_id = t.id AND m.delivery_state IN ('queued', 'seen', 'acting'))
        OR EXISTS (SELECT 1 FROM agent_runs r WHERE r.thread_id = t.id AND r.status = 'running')
        OR EXISTS (SELECT 1 FROM agent_objectives o WHERE o.thread_id = t.id AND o.deleted_at IS NULL AND o.status IN ('active', 'blocked', 'paused'))
        OR EXISTS (SELECT 1 FROM approvals a WHERE a.thread_id = t.id AND a.status = 'pending')
    )`;
}

type BatchRow = { id: string | null; company_id: string | null; candidates: number };

/** One batch: archive, then put back any chat that got activity meanwhile. */
async function archiveBatch(now: Date, limit: number): Promise<{ archived: { id: string; companyId: string }[]; candidates: number }> {
    // Timestamp columns hold UTC wall time (drizzle writes toISOString()).
    const at = now.toISOString();
    return db.transaction(async (tx) => {
        const result = await tx.execute(sql`
            WITH candidates AS MATERIALIZED (
                SELECT t.id, t.company_id, t.direct_agent_id, t.owner_user_id
                  FROM message_threads t
                  JOIN companies c ON c.id = t.company_id
                 WHERE c.multi_chat_idle_archive_days IS NOT NULL
                   AND c.multi_chat_enabled
                   AND c.direct_chat_mode = 'private'
                   AND t.type = 'direct'
                   AND t.owner_user_id IS NOT NULL
                   AND t.direct_agent_id IS NOT NULL
                   AND t.archived_at IS NULL
                   AND NOT t.is_main
                   AND t.created_at < ${cutoffOf(at)}
                   AND (t.restored_at IS NULL OR t.restored_at < ${cutoffOf(at)})
                   AND NOT ${keepsChatOpen(cutoffOf(at))}
                 ORDER BY t.created_at, t.id
                 LIMIT ${limit}
            ),
            locked AS MATERIALIZED (
                SELECT id FROM candidates
                 WHERE pg_try_advisory_xact_lock(hashtext('direct-thread:' || company_id || ':' || direct_agent_id || ':' || owner_user_id))
            ),
            archived AS (
                UPDATE message_threads t
                   SET archived_at = ${at}::timestamp, archive_reason = 'idle'
                  FROM locked l
                 WHERE t.id = l.id AND t.archived_at IS NULL AND NOT t.is_main
             RETURNING t.id, t.company_id
            )
            SELECT a.id, a.company_id, (SELECT count(*) FROM candidates)::int AS candidates FROM archived a
            UNION ALL
            SELECT NULL, NULL, (SELECT count(*) FROM candidates)::int WHERE NOT EXISTS (SELECT 1 FROM archived)
        `);
        const rows = (result.rows ?? []) as BatchRow[];
        const candidates = Number(rows[0]?.candidates ?? 0);
        const archived = rows.flatMap((r) => (r.id && r.company_id ? [{ id: r.id, companyId: r.company_id }] : []));
        if (archived.length === 0) return { archived, candidates };

        // A new statement sees what was committed while the UPDATE ran.
        const revived = await tx.execute(sql`
            UPDATE message_threads t
               SET archived_at = NULL, archive_reason = NULL
              FROM companies c
             WHERE c.id = t.company_id
               AND t.id IN (${sql.join(archived.map((r) => sql`${r.id}::uuid`), sql`, `)})
               AND t.archive_reason = 'idle' AND t.archived_at = ${at}::timestamp
               AND ${keepsChatOpen(cutoffOf(at))}
         RETURNING t.id
        `);
        const back = new Set(((revived.rows ?? []) as { id: string }[]).map((r) => r.id));
        return { archived: archived.filter((r) => !back.has(r.id)), candidates };
    });
}

/**
 * Archives idle extra private chats across all companies and writes one
 * summary audit row per company. Returns how many chats were archived.
 */
export async function archiveIdlePrivateChats(now: Date = new Date()): Promise<number> {
    const perCompany = new Map<string, number>();
    let total = 0;
    try {
        for (let batch = 0; batch < IDLE_ARCHIVE_MAX_BATCHES; batch++) {
            const { archived, candidates } = await archiveBatch(now, IDLE_ARCHIVE_BATCH);
            for (const row of archived) perCompany.set(row.companyId, (perCompany.get(row.companyId) ?? 0) + 1);
            total += archived.length;
            // A short batch means nothing idle is left; a full batch that
            // archived nothing (all locked or revived) would only repeat itself.
            if (candidates < IDLE_ARCHIVE_BATCH || archived.length === 0) break;
        }
    } finally {
        // What was archived before a failure is still audited.
        if (perCompany.size > 0) {
            await recordAudits([...perCompany].map(([companyId, count]) => ({
                companyId,
                actor: SYSTEM_ACTOR,
                action: "company.idle_chats_archived",
                target: { type: "company" as const, id: companyId },
                meta: { count },
            }))).catch((error) => console.error("Idle chat archive audit failed:", error));
        }
    }
    return total;
}
