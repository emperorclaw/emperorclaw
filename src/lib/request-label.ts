/** Client-safe: the sender shown for a message that came from a request. */
export function requestSourceLabel(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== "object") return null;
    const req = (metadata as Record<string, unknown>).agentRequest as { source?: string; requestedBy?: string | null } | undefined;
    if (!req?.source) return null;
    return `${req.source} (via API)${req.requestedBy ? ` · on behalf of ${req.requestedBy}` : ""}`;
}
