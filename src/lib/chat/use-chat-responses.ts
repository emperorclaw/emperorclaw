"use client";

import { useCallback, useState } from "react";
import { useLivePoll } from "@/lib/use-realtime";
import type { ChatPreview } from "./response-contract";

export function useChatResponses(url: string, threadId: string | null | undefined) {
    const [state, setState] = useState<{ key: string; rows: ChatPreview[]; experience?: boolean; streaming?: boolean }>({ key: "", rows: [] });
    const load = useCallback(async (poll: { readonly active: boolean }) => {
        const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}previews=1`, { cache: "no-store" });
        if (!poll.active) return;
        if (!response.ok) { setState({ key: url, rows: [] }); return; }
        const data = await response.json();
        if (poll.active) setState({ key: url, rows: Array.isArray(data.previews) ? data.previews : [], experience: data.experience !== false, streaming: data.streaming === true });
    }, [url]);
    const { status } = useLivePoll(load, { resetKey: url, enabled: Boolean(threadId), fastMs: state.streaming === false ? 30_000 : 1500, slowMs: state.streaming === false ? 30_000 : 10_000,
        throttleMs: 33, topics: threadId ? [`response:${threadId}`, `thread:${threadId}`] : [] });
    return { previews: state.key === url ? state.rows : [], experience: state.experience !== false, status };
}

/** A preview and its saved reply occupy one virtual row with a stable key. */
export function withResponsePreviews<T extends { id: string; createdAt: string | Date; text: string; senderType: string }>(messages: T[], previews: ChatPreview[], make: (preview: ChatPreview) => T): T[] {
    const ids = new Set(messages.map(message => message.id));
    const live = previews.filter(preview => !preview.finalMessageId || !ids.has(preview.finalMessageId));
    if (live.length === 0) return messages;
    return [...messages, ...live.map(make)].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}
export function responseRowKey(id: string, previews: ChatPreview[]): string {
    return previews.filter(preview => preview.finalMessageId === id).at(-1)?.responseId ?? id;
}

const humanKeys = new Map<string, string>();
export function rememberHumanMessageKey(messageId: string, clientMessageId: string) {
    humanKeys.set(messageId, clientMessageId);
    if (humanKeys.size > 2048) humanKeys.delete(humanKeys.keys().next().value!);
}
export function chatRowKey(message: { id: string; clientMessageId?: string | null }, previews: ChatPreview[]) {
    return message.clientMessageId ?? humanKeys.get(message.id) ?? responseRowKey(message.id, previews);
}
