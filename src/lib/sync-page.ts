/**
 * Paging rules of GET /api/mcp/messages/sync (bridge 0.9 review M7, H3).
 *
 * The query returns rows OLDEST first after the cursor (`ORDER BY created_at ASC, id ASC`) and
 * asks for one row more than a page, so a long outage is drained page by page instead of losing
 * everything but the newest 100. `hasMore` tells the runtime to fetch the next page at once.
 *
 * The query also always includes this agent's still-open targeted messages (queued/seen/acting)
 * and the runtime's retry ids, whatever the cursor. Those alone are not a reason to end the long
 * poll early: a running turn would otherwise make every sync return at once (the bridge spun on
 * it). `hasNew` is true when the page holds something after the cursor or an explicit retry id.
 */

/** Messages per sync page. */
export const SYNC_PAGE_SIZE = 100;
/** The cursor is compared with this slack for sub-millisecond drift between servers and DB. */
export const SYNC_CURSOR_SLACK_MS = 10;

export type SyncRow = { id: string; createdAt: Date | string };

export type SyncPage<T> = { page: T[]; hasMore: boolean; hasNew: boolean; nextSince: string | null };

export function selectSyncPage<T extends SyncRow>(
    rows: T[],
    options: { since: Date | null; retryIds?: Iterable<string>; limit?: number },
): SyncPage<T> {
    const limit = options.limit ?? SYNC_PAGE_SIZE;
    const ordered = [...rows].sort((a, b) => {
        const delta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        return delta !== 0 ? delta : a.id.localeCompare(b.id);
    });
    const page = ordered.slice(0, limit);
    const retry = new Set(options.retryIds ?? []);
    const cursor = options.since ? options.since.getTime() - SYNC_CURSOR_SLACK_MS : null;
    const hasNew = page.some((row) => cursor === null || new Date(row.createdAt).getTime() > cursor || retry.has(row.id));
    const hasMore = ordered.length > limit;
    // With more rows waiting, the runtime advances its cursor to the end of this page even when
    // every row on it was filtered out (already answered): otherwise it would ask for the same
    // page forever and never see rows 101+ (review M7 stall).
    const last = page[page.length - 1];
    const nextSince = hasMore && last ? new Date(last.createdAt).toISOString() : null;
    return { page, hasMore, hasNew, nextSince };
}
