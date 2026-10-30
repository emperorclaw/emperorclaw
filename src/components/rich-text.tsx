"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { tidyAgentMarkdown } from "@/lib/project-board-model";
import { cn } from "@/lib/utils";

/**
 * Agent-written text (task briefs, notes, approval reasons, chat excerpts)
 * rendered as safe Markdown: raw HTML is shown as text, never executed;
 * links open in a new tab with rel="noopener noreferrer"; `javascript:` and
 * other unsafe URLs are dropped; sandboxed HTML widgets are off.
 *
 * Long content starts clipped with a fade and a "Show more" toggle so one
 * long brief does not push the rest of a drawer or timeline off screen.
 */
export function RichText({
    content,
    className,
    collapsedHeight = 240,
    allowWidgets = false,
    density = "compact",
}: {
    content: string;
    className?: string;
    /** Height in px to clip at. Content within ~1.25x of it is never clipped. */
    collapsedHeight?: number;
    allowWidgets?: boolean;
    density?: "default" | "compact";
}) {
    const bodyRef = useRef<HTMLDivElement>(null);
    const t = useTranslations("richText");
    const [overflows, setOverflows] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const id = useId();

    useEffect(() => {
        const el = bodyRef.current;
        if (!el) return;
        const measure = () => setOverflows(el.scrollHeight > collapsedHeight * 1.25);
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [collapsedHeight, content]);

    const clipped = overflows && !expanded;

    return (
        <div className={cn("min-w-0 text-sm", className)}>
            <div
                ref={bodyRef}
                id={id}
                className={cn("relative min-w-0 overflow-hidden break-words", clipped && "[mask-image:linear-gradient(to_bottom,black_65%,transparent)]")}
                style={clipped ? { maxHeight: collapsedHeight } : undefined}
            >
                <MarkdownRenderer content={tidyAgentMarkdown(content)} density={density} allowWidgets={allowWidgets} className="[&>*:last-child]:mb-0" />
            </div>
            {overflows && (
                <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={id}
                    onClick={() => setExpanded((value) => !value)}
                    className="mt-1.5 inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-cyan-300 transition-colors hover:bg-cyan-400/10 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
                >
                    {expanded ? t("showLess") : t("showMore")}
                    <IconChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", expanded && "rotate-180")} aria-hidden="true" />
                </button>
            )}
        </div>
    );
}
