"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Opening a conversation (a new `key`) always lands on the newest message, then
 * follows layout growth only while the reader owns the live edge.
 *
 * An older version restored the last reading position per conversation; that
 * reopened chats somewhere in the past instead of at the latest messages.
 */
export function useChatScroll(key: string, loading: boolean, scrollRef: RefObject<HTMLDivElement | null>, followingRef: RefObject<boolean>, forceRef: RefObject<boolean>, enabled = true) {
    const restored = useRef<string | null>(null);
    const [overlayOffset, setOverlayOffset] = useState(96);
    useLayoutEffect(() => {
        if (!enabled || loading || !scrollRef.current) return;
        const node = scrollRef.current;
        if (restored.current !== key) {
            restored.current = key;
            followingRef.current = true;
            forceRef.current = true;
            node.scrollTop = node.scrollHeight;
        }
        const placeOverlay = () => {
            const parent = node.parentElement;
            if (parent) setOverlayOffset(Math.max(12, Math.round(parent.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom + 12)));
        };
        placeOverlay();
        let frame = 0;
        const selecting = () => {
            const selection = window.getSelection();
            return Boolean(selection && !selection.isCollapsed && selection.anchorNode && node.contains(selection.anchorNode));
        };
        const follow = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                if (followingRef.current && !selecting()) node.scrollTop = node.scrollHeight;
            });
        };
        const release = (event: WheelEvent) => { if (event.deltaY < 0) followingRef.current = false; };
        const pauseForSelection = () => { if (selecting()) followingRef.current = false; };
        document.addEventListener("selectionchange", pauseForSelection);
        const resize = new ResizeObserver(() => { placeOverlay(); follow(); });
        const observe = () => { resize.disconnect(); resize.observe(node); for (const child of node.children) resize.observe(child); };
        const mutation = new MutationObserver(() => { observe(); follow(); });
        observe();
        mutation.observe(node, { childList: true });
        node.addEventListener("wheel", release, { passive: true });
        follow();
        return () => {
            cancelAnimationFrame(frame);
            resize.disconnect(); mutation.disconnect();
            document.removeEventListener("selectionchange", pauseForSelection);
            node.removeEventListener("wheel", release);
        };
    }, [key, loading, scrollRef, followingRef, forceRef, enabled]);
    return overlayOffset;
}
