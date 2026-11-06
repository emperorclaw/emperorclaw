"use client";

import { useEffect, useState, type ReactNode } from "react";
import { revealDurationMs, revealStartOf, revealedText } from "@/lib/typing-reveal";

/**
 * The text shown while a live agent reply is being revealed, or null when it
 * is not (history, an already-revealed reply, reduced motion): then render the
 * message as usual. lib/typing-reveal.ts says which replies arrived live.
 */
export function useTypingReveal(messageId: string, text: string): string | null {
    const [shown, setShown] = useState<string | null>(() => {
        const start = revealStartOf(messageId);
        if (start === null) return null;
        const elapsed = Date.now() - start;
        return elapsed < revealDurationMs(text) ? revealedText(text, elapsed) : null;
    });
    const revealing = shown !== null;

    useEffect(() => {
        const start = revealStartOf(messageId);
        if (!revealing || start === null) return;
        const duration = revealDurationMs(text);
        let frame = 0;
        const tick = () => {
            const elapsed = Date.now() - start;
            if (elapsed >= duration) {
                setShown(null);
                return;
            }
            setShown(revealedText(text, elapsed, duration));
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [messageId, text, revealing]);

    return shown;
}

/**
 * Wraps an agent message's normal rendering. While revealing, the final
 * message is laid out invisibly underneath (so the row has its final height
 * from the start: no jank, autoscroll lands right) and the plain text grows
 * over it with a blinking caret; then the overlay goes and the message shows
 * exactly as it renders today.
 */
export function TypingReveal({ messageId, text, children }: { messageId: string; text: string; children: ReactNode }) {
    const shown = useTypingReveal(messageId, text);
    return (
        <div className="relative">
            <div className={shown !== null ? "invisible" : undefined} aria-hidden={shown !== null ? true : undefined}>
                {children}
            </div>
            {shown !== null ? (
                <div className="absolute inset-0 overflow-hidden whitespace-pre-wrap break-words" aria-hidden>
                    {shown}
                    <span className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse bg-current align-text-bottom" />
                </div>
            ) : null}
        </div>
    );
}
