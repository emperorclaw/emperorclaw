"use client";

import { forwardRef, useLayoutEffect, useRef, useImperativeHandle, useSyncExternalStore, type TextareaHTMLAttributes } from "react";
import { MentionTextarea, type MentionAgent } from "@/components/mention-textarea";
import type { ComposerStore } from "@/lib/chat/composer-store";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
    store: ComposerStore;
    enhanced?: boolean;
    onValueChange?: (value: string) => void;
    agents?: MentionAgent[];
    onSubmitMessage?: () => void;
};

/** Native editing and IME, with no transcript render for each keystroke. */
export const ChatInput = forwardRef<HTMLTextAreaElement, Props>(function ChatInput({ store, enhanced = true, onValueChange, agents, onSubmitMessage, ...props }, ref) {
    const value = useSyncExternalStore(store.subscribe, store.get, () => "");
    const inner = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => inner.current!);
    useLayoutEffect(() => {
        const node = inner.current;
        if (!node || !enhanced || CSS.supports("field-sizing", "content")) return;
        // One frame, one visible node: only the fallback needs measurement.
        const frame = requestAnimationFrame(() => {
            node.style.height = "auto";
            node.style.height = `${Math.min(160, node.scrollHeight)}px`;
        });
        return () => cancelAnimationFrame(frame);
    }, [value, enhanced]);
    const update = (text: string) => { store.set(text); onValueChange?.(text); };
    const className = `${enhanced ? "ec-chat-input" : ""} ${props.className ?? ""}`;
    if (agents) return <MentionTextarea ref={inner} value={value} onValueChange={update} agents={agents}
        onSubmit={onSubmitMessage} onPaste={props.onPaste} placeholder={props.placeholder} className={className}
        rows={props.rows} disabled={props.disabled} onBlur={props.onBlur} aria-label={props["aria-label"]} aria-describedby={props["aria-describedby"]} />;
    return <textarea {...props} ref={inner} className={className} value={value} onChange={event => update(event.target.value)} />;
});
