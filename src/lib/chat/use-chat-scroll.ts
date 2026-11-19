"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

const positions = new Map<string, { top: number; followingRef: boolean }>();

/** Follows layout growth only while the reader owns the live edge. */
export function useChatScroll(key: string, loading: boolean, scrollRef: RefObject<HTMLDivElement | null>, followingRef: RefObject<boolean>, forceRef: RefObject<boolean>, enabled = true) {
    const restored = useRef<string | null>(null);
    const [overlayOffset, setOverlayOffset] = useState(96);
    useLayoutEffect(() => {
        if (!enabled || loading || !scrollRef.current) return;
        const node = scrollRef.current;
        const saved = positions.get(key);
        if (restored.current !== key) {
            restored.current = key;
            if (saved && !saved.followingRef) {
                followingRef.current = false;
                forceRef.current = false;
                node.scrollTop = saved.top;
            }
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
        const remember = () => {
            positions.set(key, { top: node.scrollTop, followingRef: followingRef.current });
            if (positions.size > 100) positions.delete(positions.keys().next().value!);
        };
        const release = (event: WheelEvent) => { if (event.deltaY < 0) followingRef.current = false; };
        const pauseForSelection = () => { if (selecting()) followingRef.current = false; };
        document.addEventListener("selectionchange", pauseForSelection);
        const resize = new ResizeObserver(() => { placeOverlay(); follow(); });
        const observe = () => { resize.disconnect(); resize.observe(node); for (const child of node.children) resize.observe(child); };
        const mutation = new MutationObserver(() => { observe(); follow(); });
        observe();
        mutation.observe(node, { childList: true });
        node.addEventListener("scroll", remember, { passive: true });
        node.addEventListener("wheel", release, { passive: true });
        follow();
        return () => {
            cancelAnimationFrame(frame);
            resize.disconnect(); mutation.disconnect();
            document.removeEventListener("selectionchange", pauseForSelection);
            node.removeEventListener("scroll", remember); node.removeEventListener("wheel", release);
        };
    }, [key, loading, scrollRef, followingRef, forceRef, enabled]);
    return overlayOffset;
}
