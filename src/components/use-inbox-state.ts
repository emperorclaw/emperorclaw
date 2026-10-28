"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { refreshNavBadges } from "@/components/use-nav-badges";
import { ARCHIVE_UNDO_MS, type InboxStateAction } from "@/lib/inbox-state-rules";
import type { AttentionEntry } from "@/lib/team-scene";

type Keyed = Pick<AttentionEntry, "id" | "fingerprint">;

/** POST /api/inbox/state for the given entries (src/lib/inbox-state.ts). */
export async function postInboxState(action: InboxStateAction, entries: readonly Keyed[]): Promise<void> {
    if (entries.length === 0) return;
    const res = await fetch("/api/inbox/state", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, items: entries.map((e) => ({ key: e.id, fingerprint: e.fingerprint ?? null })) }),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "Couldn't update the inbox");
}

/**
 * Read and archive state for one list of inbox entries, applied at once
 * (optimistic) and kept until the server's next list agrees. Another tab's
 * change arrives through the "inbox" realtime topic (the page refreshes).
 */
export function useInboxState(entries: readonly AttentionEntry[], archived: readonly AttentionEntry[] = []) {
    const router = useRouter();
    // id -> desired flag, until the server's list says the same.
    const [readLocal, setReadLocal] = useState<ReadonlyMap<string, boolean>>(new Map());
    const [archivedLocal, setArchivedLocal] = useState<ReadonlyMap<string, AttentionEntry | null>>(new Map());
    const sent = useRef(new Set<string>());

    // Drop optimistic flags the server now reports itself.
    useEffect(() => {
        const serverRead = new Map([...entries, ...archived].map((e) => [e.id, e.read === true]));
        const serverArchived = new Set(archived.map((e) => e.id));
        const present = new Set(entries.map((e) => e.id));
        setReadLocal((prev) => {
            const next = new Map([...prev].filter(([id, want]) => serverRead.has(id) && serverRead.get(id) !== want));
            return next.size === prev.size ? prev : next;
        });
        setArchivedLocal((prev) => {
            // Archive pending: kept while the server still lists it. Undo pending: kept while it is still archived there.
            const next = new Map([...prev].filter(([id, entry]) => entry ? present.has(id) : !present.has(id) && serverArchived.has(id)));
            return next.size === prev.size ? prev : next;
        });
        sent.current = new Set([...sent.current].filter((key) => serverRead.has(key.split("\u0000")[0])));
    }, [entries, archived]);

    const settle = useCallback(() => {
        router.refresh();
        void refreshNavBadges();
    }, [router]);

    const isRead = useCallback((entry: AttentionEntry) => readLocal.get(entry.id) ?? entry.read === true, [readLocal]);

    const active = useMemo(() => {
        const restored = [...archivedLocal].flatMap(([id, want]) => want === null ? archived.filter((e) => e.id === id) : []);
        return [...entries.filter((e) => !archivedLocal.get(e.id)), ...restored.filter((e) => !entries.some((x) => x.id === e.id))];
    }, [entries, archived, archivedLocal]);

    const archivedList = useMemo(() => {
        const added = [...archivedLocal.values()].filter((e): e is AttentionEntry => e !== null && !archived.some((x) => x.id === e.id));
        return [...added, ...archived.filter((e) => archivedLocal.get(e.id) !== null)];
    }, [archived, archivedLocal]);

    const markRead = useCallback((entry: AttentionEntry) => {
        if (isRead(entry)) return;
        // Once per item state: focusing the same row again sends nothing.
        const key = `${entry.id}\u0000${entry.fingerprint ?? ""}`;
        if (sent.current.has(key)) return;
        sent.current.add(key);
        setReadLocal((prev) => new Map(prev).set(entry.id, true));
        postInboxState("read", [entry]).then(() => void refreshNavBadges()).catch(() => {
            sent.current.delete(key);
            setReadLocal((prev) => { const next = new Map(prev); next.delete(entry.id); return next; });
        });
    }, [isRead]);

    const markUnread = useCallback((entry: AttentionEntry) => {
        sent.current.delete(`${entry.id}\u0000${entry.fingerprint ?? ""}`);
        setReadLocal((prev) => new Map(prev).set(entry.id, false));
        postInboxState("unread", [entry]).then(settle).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't mark it unread"));
    }, [settle]);

    const unarchive = useCallback(async (entry: AttentionEntry, quiet = false) => {
        setArchivedLocal((prev) => new Map(prev).set(entry.id, null));
        try {
            await postInboxState("unarchive", [entry]);
            if (!quiet) toast.success("Moved back to the inbox.");
            settle();
        } catch (error) {
            setArchivedLocal((prev) => { const next = new Map(prev); next.delete(entry.id); return next; });
            toast.error(error instanceof Error ? error.message : "Couldn't move it back");
        }
    }, [settle]);

    const archive = useCallback(async (entry: AttentionEntry) => {
        setArchivedLocal((prev) => new Map(prev).set(entry.id, { ...entry, archived: true, read: true }));
        try {
            await postInboxState("archive", [entry]);
            toast("Archived. It comes back if anything changes.", {
                duration: ARCHIVE_UNDO_MS,
                action: { label: "Undo", onClick: () => void unarchive(entry, true) },
            });
            settle();
        } catch (error) {
            setArchivedLocal((prev) => { const next = new Map(prev); next.delete(entry.id); return next; });
            toast.error(error instanceof Error ? error.message : "Couldn't archive it");
        }
    }, [settle, unarchive]);

    const markAllRead = useCallback(async () => {
        const unread = active.filter((e) => !isRead(e));
        setReadLocal((prev) => { const next = new Map(prev); for (const e of unread) next.set(e.id, true); return next; });
        try {
            const res = await fetch("/api/inbox/read-all", { method: "POST" });
            if (!res.ok) throw new Error("Couldn't mark everything read");
            toast.success("Marked everything read.");
            settle();
        } catch (error) {
            setReadLocal((prev) => { const next = new Map(prev); for (const e of unread) next.delete(e.id); return next; });
            toast.error(error instanceof Error ? error.message : "Couldn't mark everything read");
        }
    }, [active, isRead, settle]);

    return { active, archivedList, isRead, markRead, markUnread, archive, unarchive, markAllRead };
}
