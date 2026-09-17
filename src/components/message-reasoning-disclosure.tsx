"use client";

import { useCallback, useState } from "react";
import { IconChevronRight } from "@tabler/icons-react";

/**
 * Collapsed disclosure for an agent message's persisted reasoning.
 *
 * Two rules drive the shape of this component:
 *
 * 1. LAZY. The transcript is fetched on the first expand, never on render.
 *    The chat panel polls, so fetching on render would pull the raw reasoning
 *    of every visible message repeatedly — exactly the payload problem that the
 *    separate `thread_message_reasoning` table exists to avoid.
 * 2. SELF-CONTAINED. The text scrolls inside its own bounded box instead of
 *    growing the message bubble. Reasoning is long, unwrapped model prose, and
 *    letting it size the bubble is what pushed chat rows past their column
 *    before; `min-w-0` plus `break-words` keeps it inside the flex parent.
 */
export function MessageReasoningDisclosure({ messageId }: { messageId: string }) {
    const [open, setOpen] = useState(false);
    const [reasoning, setReasoning] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const toggle = useCallback(async () => {
        if (open) {
            setOpen(false);
            return;
        }
        setOpen(true);
        // Fetch once and keep it: reopening an already-loaded transcript must
        // not hit the API again.
        if (reasoning !== null || loading) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/chat/reasoning?messageId=${encodeURIComponent(messageId)}`);
            if (!res.ok) throw new Error("Could not load reasoning");
            const data = await res.json();
            setReasoning(typeof data.reasoning === "string" ? data.reasoning : "");
        } catch {
            setError("Could not load reasoning");
        } finally {
            setLoading(false);
        }
    }, [open, reasoning, loading, messageId]);

    return (
        <div className="mt-2 min-w-0 border-t border-zinc-800/60 pt-1.5">
            <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-600 focus-visible:ring-offset-0"
            >
                <IconChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
                {open ? "Hide reasoning" : "Show reasoning"}
            </button>
            {open && (
                <div className="mt-1.5 min-w-0">
                    {loading && <p className="text-[11px] text-zinc-500">Loading reasoning…</p>}
                    {!loading && error && <p className="text-[11px] text-amber-400">{error}</p>}
                    {!loading && !error && reasoning === "" && (
                        <p className="text-[11px] text-zinc-500">No reasoning was recorded for this message.</p>
                    )}
                    {!loading && !error && reasoning && (
                        // Its own case, never uppercased: this is the model's own
                        // prose, and uppercasing a paragraph of it shouts.
                        <pre className="max-h-64 min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2 text-[11px] leading-relaxed text-zinc-400">
                            {reasoning}
                        </pre>
                    )}
                </div>
            )}
        </div>
    );
}
