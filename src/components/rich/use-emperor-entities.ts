"use client";

import { useEffect, useSyncExternalStore } from "react";
import { entityKey, MAX_ENTITY_REFS, type EntityRef, type EntitySummary } from "@/lib/emperor-entities";

/**
 * Shared, batched cache for live record summaries. Every chip and card on the
 * page asks for its key; asks made in the same tick go out as ONE request, and
 * a summary is refreshed at most every STALE_MS (and when the tab regains
 * focus), so a chat full of links never turns into a request per link per poll.
 */

const STALE_MS = 30_000;
const BATCH_DELAY_MS = 25;

type Entry = { value: EntitySummary | null; fetchedAt: number; status: "loading" | "ready" | "error" };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const queued = new Set<string>();
const inFlight = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let version = 0;

function emit() {
    version++;
    listeners.forEach((listener) => listener());
}

async function flush() {
    timer = null;
    const keys = [...queued].filter((key) => !inFlight.has(key));
    queued.clear();
    for (let i = 0; i < keys.length; i += MAX_ENTITY_REFS) {
        const batch = keys.slice(i, i + MAX_ENTITY_REFS);
        batch.forEach((key) => inFlight.add(key));
        try {
            const res = await fetch(`/api/ui/entities?refs=${encodeURIComponent(batch.join(","))}`, { cache: "no-store" });
            if (!res.ok) throw new Error(String(res.status));
            const data = await res.json() as { entities?: Record<string, EntitySummary | null> };
            const now = Date.now();
            for (const key of batch) cache.set(key, { value: data.entities?.[key] ?? null, fetchedAt: now, status: "ready" });
        } catch {
            const now = Date.now();
            // Keep the last good value on a failed refresh; only a record never
            // loaded shows as unavailable.
            for (const key of batch) {
                const prev = cache.get(key);
                cache.set(key, prev && prev.status === "ready" ? { ...prev, fetchedAt: now } : { value: null, fetchedAt: now, status: "error" });
            }
        } finally {
            batch.forEach((key) => inFlight.delete(key));
            emit();
        }
    }
}

function request(key: string, force = false) {
    const entry = cache.get(key);
    if (!force && entry && Date.now() - entry.fetchedAt < STALE_MS) return;
    if (inFlight.has(key)) return;
    if (!entry) cache.set(key, { value: null, fetchedAt: 0, status: "loading" });
    queued.add(key);
    if (!timer) timer = setTimeout(flush, BATCH_DELAY_MS);
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
    const refreshVisible = () => {
        if (document.visibilityState !== "visible") return;
        for (const key of cache.keys()) request(key);
    };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
}

export function useEmperorEntity(ref: EntityRef): Entry {
    const key = entityKey(ref);
    useSyncExternalStore(subscribe, () => version, () => 0);
    useEffect(() => {
        request(key);
        const interval = setInterval(() => request(key), STALE_MS);
        return () => clearInterval(interval);
    }, [key]);
    return cache.get(key) ?? { value: null, fetchedAt: 0, status: "loading" };
}
