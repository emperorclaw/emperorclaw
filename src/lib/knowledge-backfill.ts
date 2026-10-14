import { and, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { scopedResources } from "@/db/schema";
import { deriveKnowledgeSummary } from "@/lib/knowledge-summary";

/**
 * One-off backfill for notes created before `summary` existed. Runs after
 * migrations (see src/db/migrate.ts) and is idempotent: it only touches
 * non-deleted rows whose summary is still null.
 *
 * It is deliberately bounded so it can never stall boot on a large vault:
 *   - only non-soft-deleted rows are considered;
 *   - at most KNOWLEDGE_BACKFILL_MAX_ROWS are processed per boot, so a big
 *     backlog is drained over several boots instead of one long transaction;
 *   - an empty body persists the empty string (not null) so it is not
 *     re-selected on every subsequent boot;
 *   - updates are batched into a single UPDATE ... FROM (VALUES ...) per chunk;
 *   - a hung query is cut off by SET LOCAL statement_timeout inside the
 *     transaction.
 *
 * Any rows still pending after a bounded run are picked up on a later boot, or
 * lazily on read: `toKnowledgeIndexNote`/note reads derive a summary from the
 * body when the stored value is null.
 */
export const KNOWLEDGE_BACKFILL_MAX_ROWS = 2000;
export const KNOWLEDGE_BACKFILL_CHUNK_SIZE = 200;
export const KNOWLEDGE_BACKFILL_STATEMENT_TIMEOUT = "15s";

export type KnowledgeSummaryBackfillRow = { id: string; configText: string | null };

/**
 * Pure planner: the summary to persist for each row. An empty body maps to the
 * empty string so the row stops matching `summary IS NULL`.
 */
export function planKnowledgeSummaryUpdates(
  rows: KnowledgeSummaryBackfillRow[],
): { id: string; summary: string }[] {
  return rows.map((row) => ({ id: row.id, summary: deriveKnowledgeSummary(row.configText || "") }));
}

export async function backfillKnowledgeSummaries(): Promise<{ scanned: number; updated: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${KNOWLEDGE_BACKFILL_STATEMENT_TIMEOUT}'`));

    const rows = await tx
      .select({ id: scopedResources.id, configText: scopedResources.configText })
      .from(scopedResources)
      .where(and(isNull(scopedResources.summary), isNull(scopedResources.deletedAt)))
      .limit(KNOWLEDGE_BACKFILL_MAX_ROWS);

    const planned = planKnowledgeSummaryUpdates(rows);
    let updated = 0;

    for (let offset = 0; offset < planned.length; offset += KNOWLEDGE_BACKFILL_CHUNK_SIZE) {
      const chunk = planned.slice(offset, offset + KNOWLEDGE_BACKFILL_CHUNK_SIZE);
      const values = sql.join(
        chunk.map((row) => sql`(${row.id}::uuid, ${row.summary}::text)`),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE ${scopedResources} AS note
        SET summary = data.summary
        FROM (VALUES ${values}) AS data(id, summary)
        WHERE note.id = data.id
      `);
      updated += chunk.length;
    }

    return { scanned: rows.length, updated };
  });
}
