"use client";

import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export type MentionAgent = {
    id: string;
    name: string;
    avatarUrl?: string | null;
    status?: string | null;
};

type MentionTextareaProps = {
    value: string;
    onValueChange: (value: string) => void;
    agents: MentionAgent[];
    onSubmit?: () => void;
    placeholder?: string;
    className?: string;
    rows?: number;
    style?: React.CSSProperties;
    disabled?: boolean;
};

/**
 * A message textarea that shows a live-filtered agent dropdown as soon as
 * the user types "@" — this is the routing signal the OpenClaw bridge parses
 * from message text (see docs/v1.1/messaging.md), so the inserted mention
 * text is always the agent's full name, matching that convention exactly.
 */
export const MentionTextarea = forwardRef<HTMLTextAreaElement, MentionTextareaProps>(function MentionTextarea(
    { value, onValueChange, agents, onSubmit, placeholder, className, rows = 1, style, disabled },
    forwardedRef
) {
    const innerRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(forwardedRef, () => innerRef.current as HTMLTextAreaElement);

    const [mentionStart, setMentionStart] = useState<number | null>(null);
    const [mentionQuery, setMentionQuery] = useState("");
    const [highlightIndex, setHighlightIndex] = useState(0);

    const filteredAgents = useMemo(() => {
        if (mentionStart === null) return [];
        const query = mentionQuery.toLowerCase();
        const matches = query
            ? agents.filter((agent) => agent.name.toLowerCase().includes(query))
            : agents;
        return matches.slice(0, 8);
    }, [agents, mentionQuery, mentionStart]);

    const mentionOpen = mentionStart !== null && filteredAgents.length > 0;

    function detectMention(text: string, cursor: number) {
        const uptoCursor = text.slice(0, cursor);
        const atIndex = uptoCursor.lastIndexOf("@");
        if (atIndex === -1) return null;
        const charBefore = atIndex > 0 ? uptoCursor[atIndex - 1] : null;
        if (charBefore && !/\s/.test(charBefore)) return null;
        const query = uptoCursor.slice(atIndex + 1);
        if (/\s/.test(query)) return null;
        return { start: atIndex, query };
    }

    function handleChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
        const nextValue = event.target.value;
        onValueChange(nextValue);
        const cursor = event.target.selectionStart ?? nextValue.length;
        const mention = detectMention(nextValue, cursor);
        if (mention) {
            setMentionStart(mention.start);
            setMentionQuery(mention.query);
            setHighlightIndex(0);
        } else {
            setMentionStart(null);
            setMentionQuery("");
        }
    }

    function selectMention(agent: MentionAgent) {
        const textarea = innerRef.current;
        if (mentionStart === null || !textarea) return;
        const cursor = textarea.selectionStart ?? value.length;
        const before = value.slice(0, mentionStart);
        const after = value.slice(cursor);
        const insertion = `@${agent.name} `;
        const nextValue = `${before}${insertion}${after}`;
        onValueChange(nextValue);
        setMentionStart(null);
        setMentionQuery("");
        requestAnimationFrame(() => {
            const nextCursor = before.length + insertion.length;
            textarea.focus();
            textarea.setSelectionRange(nextCursor, nextCursor);
        });
    }

    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (mentionOpen) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlightIndex((i) => (i + 1) % filteredAgents.length);
                return;
            }
            if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlightIndex((i) => (i - 1 + filteredAgents.length) % filteredAgents.length);
                return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                selectMention(filteredAgents[highlightIndex]);
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                setMentionStart(null);
                setMentionQuery("");
                return;
            }
        }
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit?.();
        }
    }

    return (
        <div className="relative min-w-0 flex-1">
            {mentionOpen && (
                <div className="absolute bottom-full left-0 z-20 mb-2 w-56 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
                    <div className="border-b border-zinc-800 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                        {mentionQuery ? `Mention "${mentionQuery}"` : "Mention agent"}
                    </div>
                    <div className="max-h-48 overflow-y-auto p-1">
                        {filteredAgents.map((agent, index) => (
                            <button
                                key={agent.id}
                                type="button"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => selectMention(agent)}
                                onMouseEnter={() => setHighlightIndex(index)}
                                className={cn(
                                    "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                                    index === highlightIndex ? "bg-zinc-800" : "hover:bg-zinc-800/60"
                                )}
                            >
                                <div className="relative shrink-0">
                                    <img
                                        src={agent.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(agent.id)}`}
                                        className="h-6 w-6 rounded-full object-cover"
                                        alt=""
                                    />
                                    {agent.status && (
                                        <div className={cn(
                                            "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-zinc-900",
                                            agent.status === "online" ? "bg-emerald-500" : "bg-zinc-600"
                                        )} />
                                    )}
                                </div>
                                <span className="truncate text-sm text-zinc-300">{agent.name}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
            <textarea
                ref={innerRef}
                value={value}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                rows={rows}
                disabled={disabled}
                style={style}
                className={className}
            />
        </div>
    );
});
