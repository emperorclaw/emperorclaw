"use client";

const played = new Set<string>();
/** A keyed, bounded one-shot entrance. Content is readable even if animation pauses. */
export function messageEntranceRef(key: string, enabled: boolean) {
    return (node: HTMLDivElement | null) => {
        if (!node || !enabled || played.has(key)) return;
        played.add(key);
        if (played.size > 2048) played.delete(played.values().next().value!);
        if (document.visibilityState !== "visible" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        node.animate([{ transform: "translateY(5px)" }, { transform: "translateY(0)" }], {
            duration: 180, easing: "cubic-bezier(.16,1,.3,1)",
        });
    };
}
