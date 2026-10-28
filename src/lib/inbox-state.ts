/**
 * Per-person inbox state: read and archived, stored in inbox_item_state and
 * applied by buildAttention (src/lib/attention.ts). The rules (fingerprints,
 * resurfacing, request validation) are pure and live in
 * src/lib/inbox-state-rules.ts.
 *
 * A person may only change state on items they can see right now: the
 * visible set is recomputed with buildAttention for that viewer, so a key
 * from another person's private chat, another member's scope or another
 * company is skipped, never stored.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { inboxItemState } from "@/db/schema";
import { buildAttention, type AttentionAccess } from "@/lib/attention";
import { inboxStatePatch, type InboxStateAction, type InboxStateRequest } from "@/lib/inbox-state-rules";
import { broadcastUserEvent } from "@/lib/pubsub";

export * from "@/lib/inbox-state-rules";

export interface InboxStateResult {
    updated: string[];
    /** Keys the person cannot see right now: nothing was stored for them. */
    skipped: string[];
}

const COLUMN = { readAt: "read_at", readFingerprint: "read_fingerprint", archivedAt: "archived_at", archivedFingerprint: "archived_fingerprint" } as const;

/** One multi-row upsert: an existing row takes only the columns this action writes. */
async function upsertState(companyId: string, userId: string, items: { key: string; fingerprint: string }[], action: InboxStateAction, now: Date): Promise<void> {
    if (items.length === 0) return;
    // Postgres refuses to update one row twice in a statement: one entry per key.
    const unique = [...new Map(items.map((item) => [item.key, item])).values()];
    const written = Object.keys(inboxStatePatch(action, "", now)) as (keyof typeof COLUMN)[];
    await db.insert(inboxItemState)
        .values(unique.map((item) => ({ companyId, userId, itemKey: item.key, ...inboxStatePatch(action, item.fingerprint, now), updatedAt: now })))
        .onConflictDoUpdate({
            target: [inboxItemState.companyId, inboxItemState.userId, inboxItemState.itemKey],
            set: { ...Object.fromEntries(written.map((field) => [field, sql.raw(`excluded.${COLUMN[field]}`)])), updatedAt: now },
        });
}

/** Other tabs of this person refetch the inbox (topic "inbox"); nobody else is told. */
function announce(companyId: string, userId: string) {
    Promise.resolve(broadcastUserEvent(companyId, userId, { type: "inbox_state_updated" })).catch(() => {});
}

/**
 * Apply one action to items the viewer can currently see (active or
 * archived). A client fingerprint is kept when given (the state the person
 * acted on, so a change in between resurfaces it); otherwise the current one.
 */
export async function setInboxItemState(companyId: string, access: AttentionAccess, request: InboxStateRequest, now = new Date()): Promise<InboxStateResult> {
    const userId = access.userId;
    if (!userId) return { updated: [], skipped: request.items.map((i) => i.key) };
    const attention = await buildAttention(companyId, access, { now });
    const current = new Map([...attention.entries, ...attention.archived].map((e) => [e.id, e.fingerprint ?? ""]));
    const allowed: { key: string; fingerprint: string }[] = [];
    const skipped: string[] = [];
    for (const item of request.items) {
        const fingerprint = current.get(item.key);
        if (fingerprint === undefined) skipped.push(item.key);
        else allowed.push({ key: item.key, fingerprint: item.fingerprint ?? fingerprint });
    }
    await upsertState(companyId, userId, allowed, request.action, now);
    if (allowed.length > 0) announce(companyId, userId);
    return { updated: allowed.map((i) => i.key), skipped };
}

/** Mark every item the viewer can see as read, at its current state. */
export async function markAllInboxRead(companyId: string, access: AttentionAccess, now = new Date()): Promise<{ updated: number }> {
    const userId = access.userId;
    if (!userId) return { updated: 0 };
    const attention = await buildAttention(companyId, access, { now });
    const unread = attention.entries.filter((e) => !e.read).map((e) => ({ key: e.id, fingerprint: e.fingerprint ?? "" }));
    await upsertState(companyId, userId, unread, "read", now);
    if (unread.length > 0) announce(companyId, userId);
    return { updated: unread.length };
}
