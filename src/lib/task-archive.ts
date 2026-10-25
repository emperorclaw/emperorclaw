/**
 * Archiving (soft-deleting) tasks on behalf of a signed-in person. One code
 * path for the single DELETE /api/tasks/[id] and the bulk archive/unarchive
 * routes, so the company and member-scope checks cannot drift apart.
 *
 * The caller has already passed requireRole("member") (viewers never get
 * here). Each task is then kept only when it belongs to the caller's company
 * and, for a restricted member, sits in a project they may see; anything else
 * is skipped, never an error, so a stale id in a batch cannot fail the rest.
 */
import { and, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { memberVisibleProjectIds, type MemberScope } from "@/lib/member-scope";
import { broadcastMcpEvent } from "@/lib/pubsub";

export const BULK_TASK_ARCHIVE_MAX = 200;
/** Undo only reaches tasks archived this recently. */
export const TASK_UNARCHIVE_WINDOW_MS = 10 * 60_000;

type TaskRow = typeof tasks.$inferSelect;
export type ArchiveCaller = { companyId: string; scope: MemberScope | null };
/** `tasks`: the rows that changed; `skipped`: every requested id that did not. */
export type TaskArchiveResult = { tasks: TaskRow[]; skipped: string[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a `{ taskIds }` body: a non-empty array of at most
 * BULK_TASK_ARCHIVE_MAX strings. Returns the de-duplicated ids or an error.
 */
export function parseTaskIdList(body: unknown): { ids: string[] } | { error: string } {
    const raw = body && typeof body === "object" ? (body as { taskIds?: unknown }).taskIds : undefined;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((id) => typeof id !== "string")) {
        return { error: "taskIds must be a non-empty array of task ids" };
    }
    const ids = [...new Set(raw as string[])];
    if (ids.length > BULK_TASK_ARCHIVE_MAX) return { error: `At most ${BULK_TASK_ARCHIVE_MAX} tasks at a time` };
    return { ids };
}

/** Rows (from `rows`) the caller may act on: same company, and in scope for a restricted member. */
async function permitted(caller: ArchiveCaller, rows: TaskRow[]) {
    const visible = await memberVisibleProjectIds(caller.companyId, caller.scope);
    if (!visible) return rows;
    return rows.filter((row) => row.projectId !== null && visible.has(row.projectId));
}

function skippedOf(ids: string[], done: TaskRow[]) {
    const doneIds = new Set(done.map((task) => task.id));
    return ids.filter((id) => !doneIds.has(id));
}

/** Soft-delete every task in `ids` the caller may archive; the rest are skipped. */
export async function archiveTasksForCaller(caller: ArchiveCaller, ids: string[]): Promise<TaskArchiveResult> {
    const candidates = ids.filter((id) => UUID_RE.test(id));
    if (candidates.length === 0) return { tasks: [], skipped: ids };
    const rows = await db.select().from(tasks).where(and(
        inArray(tasks.id, candidates),
        eq(tasks.companyId, caller.companyId),
        isNull(tasks.deletedAt),
    ));
    const allowed = await permitted(caller, rows);
    let archived: TaskRow[] = [];
    if (allowed.length > 0) {
        const now = new Date();
        archived = await db.update(tasks).set({ deletedAt: now, updatedAt: now }).where(and(
            inArray(tasks.id, allowed.map((task) => task.id)),
            eq(tasks.companyId, caller.companyId),
            isNull(tasks.deletedAt),
        )).returning();
    }
    for (const task of archived) await broadcastMcpEvent(caller.companyId, { type: "task_updated", task });
    return { tasks: archived, skipped: skippedOf(ids, archived) };
}

/**
 * Undo a recent archive: restore tasks in `ids` archived within
 * TASK_UNARCHIVE_WINDOW_MS that the caller may edit. Older archives (and
 * anything else) are skipped, so this cannot resurrect long-gone work.
 */
export async function unarchiveTasksForCaller(caller: ArchiveCaller, ids: string[], now = new Date()): Promise<TaskArchiveResult> {
    const candidates = ids.filter((id) => UUID_RE.test(id));
    if (candidates.length === 0) return { tasks: [], skipped: ids };
    const since = new Date(now.getTime() - TASK_UNARCHIVE_WINDOW_MS);
    const rows = await db.select().from(tasks).where(and(
        inArray(tasks.id, candidates),
        eq(tasks.companyId, caller.companyId),
        isNotNull(tasks.deletedAt),
        gte(tasks.deletedAt, since),
    ));
    const allowed = await permitted(caller, rows);
    let restored: TaskRow[] = [];
    if (allowed.length > 0) {
        restored = await db.update(tasks).set({ deletedAt: null, updatedAt: new Date() }).where(and(
            inArray(tasks.id, allowed.map((task) => task.id)),
            eq(tasks.companyId, caller.companyId),
            isNotNull(tasks.deletedAt),
        )).returning();
    }
    for (const task of restored) await broadcastMcpEvent(caller.companyId, { type: "task_updated", task });
    return { tasks: restored, skipped: skippedOf(ids, restored) };
}
