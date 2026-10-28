/**
 * Pure rules for per-person inbox state (read / archived). The inbox is
 * derived (src/lib/attention.ts), so state is keyed by the entry id and
 * pinned to a fingerprint of the entry's meaningful state: when the item
 * changes, the old read or archive no longer applies and it comes back.
 * No database here (src/lib/inbox-state.ts stores it); unit-tested in
 * tests/unit/inbox-state.test.ts. Safe to import from client components.
 */

import type { AttentionEntry } from "@/lib/team-scene";

export type InboxStateAction = "read" | "unread" | "archive" | "unarchive";

export const INBOX_STATE_ACTIONS: readonly InboxStateAction[] = ["read", "unread", "archive", "unarchive"];

/** Most items one request may change. */
export const INBOX_STATE_MAX_ITEMS = 200;

const MAX_KEY_LENGTH = 200;
const MAX_FINGERPRINT_LENGTH = 64;

/** How long the Undo on an archive stays offered, in milliseconds. */
export const ARCHIVE_UNDO_MS = 8000;

/** One person's stored state for one item (a row of inbox_item_state). */
export interface InboxItemStateRow {
    itemKey: string;
    readAt: Date | string | null;
    readFingerprint: string | null;
    archivedAt: Date | string | null;
    archivedFingerprint: string | null;
}

/** FNV-1a, 32 bit, as 8 hex characters: short, stable, the same in Node and the browser. */
function hash(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The item's meaningful state: its kind, when the situation started (an
 * explicit seed when `at` moves on its own, e.g. a blocked agent's heartbeat),
 * and the failure cause. A new occurrence (the agent drops offline again, a
 * newer failure, a task updated) gives a new fingerprint.
 */
export function inboxFingerprint(entry: Pick<AttentionEntry, "kind" | "at" | "fingerprintSeed" | "failure">): string {
    const seed = entry.fingerprintSeed ?? entry.at;
    return hash(`${entry.kind}|${seed}|${entry.failure?.cause ?? ""}`);
}

/** Read, and still about the same state it was read in. */
export function isReadNow(row: InboxItemStateRow | null | undefined, fingerprint: string): boolean {
    return Boolean(row?.readAt) && row?.readFingerprint === fingerprint;
}

/** Archived, and the item has not changed since: it stays hidden. A change resurfaces it. */
export function isArchivedNow(row: InboxItemStateRow | null | undefined, fingerprint: string): boolean {
    return Boolean(row?.archivedAt) && row?.archivedFingerprint === fingerprint;
}

/** Each entry with its fingerprint and this person's read/archived flags. */
export function withInboxState<E extends AttentionEntry>(entries: readonly E[], rows: readonly InboxItemStateRow[]): E[] {
    const byKey = new Map(rows.map((row) => [row.itemKey, row]));
    return entries.map((entry) => {
        const fingerprint = inboxFingerprint(entry);
        const row = byKey.get(entry.id);
        return { ...entry, fingerprint, read: isReadNow(row, fingerprint), archived: isArchivedNow(row, fingerprint) };
    });
}

/** Split into what the inbox lists and what the Archived filter lists. */
export function splitArchived<E extends AttentionEntry>(entries: readonly E[]): { active: E[]; archived: E[] } {
    const active: E[] = [];
    const archived: E[] = [];
    for (const entry of entries) (entry.archived ? archived : active).push(entry);
    return { active, archived };
}

export interface InboxStatePatch {
    readAt?: Date | null;
    readFingerprint?: string | null;
    archivedAt?: Date | null;
    archivedFingerprint?: string | null;
}

/** The columns one action writes. Archiving also marks the item read. */
export function inboxStatePatch(action: InboxStateAction, fingerprint: string, now: Date): InboxStatePatch {
    switch (action) {
        case "read": return { readAt: now, readFingerprint: fingerprint };
        case "unread": return { readAt: null, readFingerprint: null };
        case "archive": return { archivedAt: now, archivedFingerprint: fingerprint, readAt: now, readFingerprint: fingerprint };
        case "unarchive": return { archivedAt: null, archivedFingerprint: null };
    }
}

export interface InboxStateRequest {
    action: InboxStateAction;
    items: { key: string; fingerprint: string | null }[];
}

/** Validate a POST /api/inbox/state body. Duplicate keys collapse to the last one. */
export function parseInboxStateRequest(body: unknown): { ok: true; value: InboxStateRequest } | { ok: false; error: string } {
    const b = (body && typeof body === "object" ? body : {}) as { action?: unknown; items?: unknown };
    if (!INBOX_STATE_ACTIONS.includes(b.action as InboxStateAction)) return { ok: false, error: "action must be read, unread, archive or unarchive" };
    if (!Array.isArray(b.items) || b.items.length === 0) return { ok: false, error: "items must be a non-empty list" };
    if (b.items.length > INBOX_STATE_MAX_ITEMS) return { ok: false, error: `At most ${INBOX_STATE_MAX_ITEMS} items per request` };
    const byKey = new Map<string, string | null>();
    for (const raw of b.items) {
        const item = (raw && typeof raw === "object" ? raw : {}) as { key?: unknown; fingerprint?: unknown };
        if (typeof item.key !== "string" || !item.key || item.key.length > MAX_KEY_LENGTH) return { ok: false, error: "Each item needs a key" };
        const fingerprint = item.fingerprint === undefined || item.fingerprint === null ? null : item.fingerprint;
        if (fingerprint !== null && (typeof fingerprint !== "string" || !fingerprint || fingerprint.length > MAX_FINGERPRINT_LENGTH)) return { ok: false, error: "Invalid fingerprint" };
        byKey.set(item.key, fingerprint);
    }
    return { ok: true, value: { action: b.action as InboxStateAction, items: [...byKey].map(([key, fingerprint]) => ({ key, fingerprint })) } };
}

/** Client-side inbox search: title, reason, agent or person, project and customer. */
export function matchesInboxSearch(entry: Pick<AttentionEntry, "title" | "reason" | "detail" | "memberName" | "area" | "customerName">, query: string): boolean {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const haystack = [entry.title, entry.reason, entry.detail, entry.memberName, entry.area, entry.customerName].filter(Boolean).join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
}
