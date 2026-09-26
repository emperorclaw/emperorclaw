"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { IconArrowsMaximize, IconSend } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { buildWidgetDocument, WIDGET_THEME_TOKENS, widgetTitle } from "@/lib/rich-blocks";
import { RichBlockCard } from "./rich-block-card";
import { useRichMessageActions } from "./rich-message-actions";

const MIN_HEIGHT = 48;
const MAX_INLINE_HEIGHT = 1100;
const SEND_COOLDOWN_MS = 1500;

interface ThemeSnapshot {
    tokens: Record<string, string>;
    colorScheme: "light" | "dark";
    fontFamily: string;
    key: string;
}

function readTheme(): ThemeSnapshot {
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const tokens: Record<string, string> = {};
    for (const name of WIDGET_THEME_TOKENS) {
        const value = styles.getPropertyValue(`--${name}`).trim();
        if (value) tokens[name] = value;
    }
    const colorScheme = root.classList.contains("dark") ? "dark" : "light";
    const fontFamily = getComputedStyle(document.body).fontFamily;
    return { tokens, colorScheme, fontFamily, key: `${colorScheme}:${tokens.background ?? ""}:${tokens.primary ?? ""}` };
}

function themeKey(): string {
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    return `${root.classList.contains("dark") ? "dark" : "light"}:${styles.getPropertyValue("--background").trim()}:${styles.getPropertyValue("--primary").trim()}`;
}

function subscribeTheme(onChange: () => void): () => void {
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => observer.disconnect();
}

/** The app's resolved theme, re-read when the theme class flips. A theme
 *  change rebuilds the srcdoc, which reloads the widget in the new colors.
 *  The server snapshot is a placeholder, so server and client markup agree
 *  and the frame only mounts once the real theme is known. */
function useThemeSnapshot(): ThemeSnapshot {
    const key = useSyncExternalStore(subscribeTheme, themeKey, () => "ssr");
    return useMemo(
        () => (key === "ssr" ? { tokens: {}, colorScheme: "dark" as const, fontFamily: "", key } : readTheme()),
        [key],
    );
}

function randomToken(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * One sandboxed frame. `sandbox="allow-scripts"` WITHOUT `allow-same-origin`
 * gives the widget an opaque origin: its scripts run, but it cannot read the
 * app's DOM, cookies, or storage, navigate the page, open popups, or submit
 * forms. The in-document CSP (see WIDGET_CSP) additionally blocks network
 * access, so postMessage — validated here by source frame and token — is its
 * only channel out.
 */
function WidgetFrame({
    html,
    title,
    fill = false,
    onSend,
}: {
    html: string;
    title: string;
    fill?: boolean;
    onSend: (prompt: string) => void;
}) {
    const frameRef = useRef<HTMLIFrameElement>(null);
    const token = useMemo(() => randomToken(), []);
    const theme = useThemeSnapshot();
    const [height, setHeight] = useState<number | null>(null);

    const srcDoc = useMemo(
        () => buildWidgetDocument(html, { token, theme: theme.tokens, colorScheme: theme.colorScheme, fontFamily: theme.fontFamily }),
        [html, token, theme],
    );

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
            const data = event.data as { type?: unknown; token?: unknown; height?: unknown; prompt?: unknown } | null;
            if (!data || typeof data !== "object" || data.token !== token) return;
            if (data.type === "emperor-widget:size" && typeof data.height === "number" && Number.isFinite(data.height)) {
                setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_INLINE_HEIGHT, Math.ceil(data.height))));
            } else if (data.type === "emperor-widget:send" && typeof data.prompt === "string") {
                onSend(data.prompt);
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [onSend, token]);

    return (
        <div className="relative w-full" style={fill ? { height: "100%" } : height === null ? { minHeight: 180 } : undefined}>
            {height === null && !fill && (
                <div className="absolute inset-0 animate-pulse rounded-b-xl bg-zinc-800/30" aria-hidden />
            )}
            {theme.key !== "ssr" && <iframe
                ref={frameRef}
                title={title}
                sandbox="allow-scripts"
                srcDoc={srcDoc}
                referrerPolicy="no-referrer"
                loading="lazy"
                className="block w-full border-0 bg-transparent"
                style={{ height: fill ? "100%" : height ?? 180, colorScheme: theme.colorScheme, transition: "height 160ms ease-out" }}
            />}
        </div>
    );
}

export function HtmlWidget({ html }: { html: string }) {
    const { sendPrompt } = useRichMessageActions();
    const [expanded, setExpanded] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const lastSendRef = useRef(0);
    const title = useMemo(() => widgetTitle(html), [html]);

    const flash = useCallback((text: string) => {
        setNotice(text);
        window.setTimeout(() => setNotice((current) => (current === text ? null : current)), 2600);
    }, []);

    // A widget may only speak for the operator right after the operator
    // touched it. User activation propagates from the clicked frame to this
    // page, so a script firing on its own (on load, on a timer) is refused.
    const onSend = useCallback((prompt: string) => {
        const text = prompt.trim().slice(0, 500);
        if (!text) return;
        if (!sendPrompt) {
            flash("Widget actions aren't available here");
            return;
        }
        const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
        if (activation && !activation.isActive) return;
        const now = Date.now();
        if (now - lastSendRef.current < SEND_COOLDOWN_MS) return;
        lastSendRef.current = now;
        flash(`Sent: ${text.length > 60 ? `${text.slice(0, 57)}…` : text}`);
        void sendPrompt(text);
    }, [flash, sendPrompt]);

    return (
        <>
            <RichBlockCard
                kind="widget"
                title={title}
                source={html}
                sourceLanguage="html"
                bleed
                actions={
                    <button
                        type="button"
                        onClick={() => setExpanded(true)}
                        aria-label="Open full screen"
                        title="Open full screen"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                    >
                        <IconArrowsMaximize className="h-3.5 w-3.5" />
                    </button>
                }
            >
                <div className="relative p-3.5">
                    {!expanded && <WidgetFrame html={html} title={title} onSend={onSend} />}
                    {notice && (
                        <div role="status" className="ec-rich-fade pointer-events-none absolute bottom-2 right-2 inline-flex max-w-[80%] items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/95 px-2.5 py-1 text-[11px] text-zinc-300 shadow-lg">
                            <IconSend className="h-3 w-3 shrink-0 text-cyan-400" />
                            <span className="truncate">{notice}</span>
                        </div>
                    )}
                </div>
            </RichBlockCard>
            <Dialog open={expanded} onOpenChange={setExpanded}>
                <DialogContent className="flex h-[88vh] max-w-[min(1200px,calc(100%-2rem))] flex-col gap-3 p-4 sm:max-w-[min(1200px,calc(100%-2rem))]">
                    <DialogTitle className="pr-8 text-base">{title}</DialogTitle>
                    <DialogDescription className="sr-only">Interactive widget sent by an agent, running in a sandbox.</DialogDescription>
                    <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                        {expanded && <WidgetFrame html={html} title={title} fill onSend={onSend} />}
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
