"use client";

import React, { useState } from "react";
import { IconCheck, IconLoader2 } from "@tabler/icons-react";
import type { ChoicesSpec } from "@/lib/rich-blocks";
import { cn } from "@/lib/utils";
import { useRichMessageActions } from "./rich-message-actions";

const STYLE = {
    primary: "border-cyan-500/50 bg-cyan-500/15 text-cyan-100 hover:border-cyan-400 hover:bg-cyan-500/25",
    danger: "border-rose-500/40 bg-rose-500/10 text-rose-200 hover:border-rose-400 hover:bg-rose-500/20",
    default: "border-zinc-700 bg-zinc-800/60 text-zinc-100 hover:border-zinc-500 hover:bg-zinc-800",
} as const;

function normalize(text: string): string {
    return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Quick-reply buttons from a ```choices block. A click sends the option's
 * prompt as the operator (the same visible message they could have typed).
 * Once any later operator message matches an option, the block shows that
 * answer and locks, so a decision can't be sent twice after a reload.
 */
export function ChoicesBlock({ spec }: { spec: ChoicesSpec }) {
    const { sendPrompt, laterReplies } = useRichMessageActions();
    const [sending, setSending] = useState<number | null>(null);
    const [picked, setPicked] = useState<number | null>(null);

    const replies = (laterReplies ?? []).map(normalize);
    const answeredIndex = spec.options.findIndex((o) => replies.includes(normalize(o.prompt)) || replies.includes(normalize(o.label)));
    const chosen = picked ?? (answeredIndex >= 0 ? answeredIndex : null);
    const locked = chosen !== null || sending !== null;
    const inert = !sendPrompt;

    const choose = async (index: number) => {
        if (!sendPrompt || locked) return;
        setSending(index);
        try {
            const sent = await sendPrompt(spec.options[index].prompt);
            if (sent !== false) setPicked(index);
        } finally {
            setSending(null);
        }
    };

    return (
        <div className="not-prose my-3 w-full min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            {spec.question && <div className="mb-2.5 text-sm font-medium text-zinc-100">{spec.question}</div>}
            <div className="flex flex-wrap gap-2" role="group" aria-label={spec.question || "Choices"}>
                {spec.options.map((option, i) => {
                    const isChosen = chosen === i;
                    return (
                        <button
                            key={i}
                            type="button"
                            disabled={inert || (locked && !isChosen)}
                            aria-pressed={isChosen}
                            onClick={() => void choose(i)}
                            title={option.prompt !== option.label ? option.prompt : option.hint}
                            className={cn(
                                "inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-lg border px-3 py-1.5 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50",
                                STYLE[option.style],
                                isChosen && "border-emerald-500/60 bg-emerald-500/15 text-emerald-100 hover:border-emerald-500/60 hover:bg-emerald-500/15",
                                locked && !isChosen && "opacity-40",
                                (inert || locked) && "cursor-default",
                            )}
                        >
                            {sending === i ? <IconLoader2 className="h-4 w-4 shrink-0 animate-spin" /> : isChosen ? <IconCheck className="h-4 w-4 shrink-0" /> : null}
                            <span className="min-w-0">
                                <span className="block truncate">{option.label}</span>
                                {option.hint && <span className="block truncate text-xs font-normal opacity-70">{option.hint}</span>}
                            </span>
                        </button>
                    );
                })}
            </div>
            {inert && <div className="mt-2 text-xs text-zinc-500">Reply in the chat to answer.</div>}
        </div>
    );
}
