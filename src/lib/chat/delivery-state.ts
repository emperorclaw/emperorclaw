/**
 * Footer copy for a human message's delivery state
 * (`queued | seen | acting | resolved`, set by the bridge through
 * updateThreadExecutionState).
 */

export const DELIVERY_LABEL_KEYS = ["cancelled", "beingHandled", "seen", "queued"] as const;
export type DeliveryLabelKey = (typeof DELIVERY_LABEL_KEYS)[number];

/**
 * `queued` is not a stale name for `seen`: it is the honest "the runtime has
 * not taken this prompt yet" state (host offline, or the turn waiting for the
 * parallel-turn limit) and keeps its own copy. `seen` means the bridge already
 * picked the prompt up and the turn has not started, so it must not read as
 * Queued either. `resolved` never reaches the footer (the thread-level
 * Read/Sent receipt renders instead) and an unknown newer state is still a
 * message on its way, so both fall back to `queued`.
 */
export function deliveryLabelKey(state: string | null | undefined): DeliveryLabelKey {
    if (state === "cancelled") return "cancelled";
    if (state === "acting") return "beingHandled";
    if (state === "seen") return "seen";
    return "queued";
}

export type PreviewStatusKey = "responding" | "finishing" | "stepComplete" | "previewCapped" | "interrupted";

/**
 * The one-line status under a streaming preview message. `running` is the only
 * case the chat's own thinking row already says out loud, so it yields no line
 * while that row is on screen (null); it stays as the fallback when the row is
 * not there. The settled and failure states always render.
 */
export function previewStatusKey(state: string, thinkingRowVisible: boolean): PreviewStatusKey | null {
    if (state === "running") return thinkingRowVisible ? null : "responding";
    if (state === "succeeded") return "finishing";
    if (state === "sealed") return "stepComplete";
    if (state === "capped") return "previewCapped";
    return "interrupted";
}
