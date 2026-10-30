import { copy, type CodedCopy } from "@/lib/coded-copy";

/** Client-safe: the sender shown for a message that came from a request. */
export function requestSourceLabel(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== "object") return null;
    const req = (metadata as Record<string, unknown>).agentRequest as { source?: string; requestedBy?: string | null } | undefined;
    if (!req?.source) return null;
    return `${req.source} (via API)${req.requestedBy ? ` · on behalf of ${req.requestedBy}` : ""}`;
}

/** requestSourceLabel as coded copy (directChat.requestSource*), for the viewer's language. */
export function requestSourceCopy(metadata: unknown): CodedCopy | null {
    if (!metadata || typeof metadata !== "object") return null;
    const req = (metadata as Record<string, unknown>).agentRequest as { source?: string; requestedBy?: string | null } | undefined;
    if (!req?.source) return null;
    return req.requestedBy
        ? copy("directChat.requestSourceOnBehalf", { source: req.source, by: req.requestedBy })
        : copy("directChat.requestSource", { source: req.source });
}
