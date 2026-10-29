import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * Loading placeholders. The pulse only runs when the viewer allows motion
 * (motion-safe), so prefers-reduced-motion gets a still block. Every
 * skeleton is aria-hidden; the wrapping `SkeletonPage` announces "Loading"
 * once for screen readers.
 */
export function Skeleton({ className }: { className?: string }) {
    return <div aria-hidden className={cn("rounded-md bg-muted motion-safe:animate-pulse", className)} />;
}

/** A few text lines; the last one is shorter, like a paragraph. */
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
    return (
        <div aria-hidden className={cn("space-y-2", className)}>
            {Array.from({ length: lines }, (_, i) => (
                <Skeleton key={i} className={cn("h-3", i === lines - 1 && lines > 1 ? "w-2/3" : "w-full")} />
            ))}
        </div>
    );
}

/** A card: a title bar and a few lines. */
export function SkeletonCard({ lines = 3, className }: { lines?: number; className?: string }) {
    return (
        <div aria-hidden className={cn("rounded-2xl border border-border bg-card p-4 sm:p-5", className)}>
            <Skeleton className="mb-4 h-4 w-1/3" />
            <SkeletonLines lines={lines} />
        </div>
    );
}

/** Table rows: a header strip and `rows` rows of `columns` cells. */
export function SkeletonTable({ rows = 6, columns = 4, className }: { rows?: number; columns?: number; className?: string }) {
    return (
        <div aria-hidden className={cn("overflow-hidden rounded-2xl border border-border bg-card", className)}>
            <div className="flex gap-4 border-b border-border px-5 py-3">
                {Array.from({ length: columns }, (_, c) => <Skeleton key={c} className="h-3 flex-1" />)}
            </div>
            <div className="divide-y divide-border">
                {Array.from({ length: rows }, (_, r) => (
                    <div key={r} className="flex items-center gap-4 px-5 py-3.5">
                        {Array.from({ length: columns }, (_, c) => (
                            <Skeleton key={c} className={cn("h-3 flex-1", c === 0 && "max-w-[40%]")} />
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}

/** A page header placeholder: eyebrow, title, description and an action. */
export function SkeletonHeader({ action = true }: { action?: boolean }) {
    return (
        <div aria-hidden className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-7 w-56" />
                <Skeleton className="h-3.5 w-80 max-w-[70vw]" />
            </div>
            {action && <Skeleton className="h-9 w-32 rounded-xl" />}
        </div>
    );
}

/** The route-level wrapper: one polite "Loading…" for assistive tech. */
export function SkeletonPage({ label, children, className }: { label?: string; children: ReactNode; className?: string }) {
    const t = useTranslations("common");
    return (
        <div role="status" aria-live="polite" aria-busy="true" className={cn("mx-auto w-full max-w-[1600px] space-y-6", className)}>
            <span className="sr-only">{label ?? t("loading")}…</span>
            {children}
        </div>
    );
}
