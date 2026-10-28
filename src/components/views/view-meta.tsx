"use client";

import Link from "next/link";
import { IconAlertTriangle, IconArchive, IconLock, IconPin, IconUsers, IconWorld } from "@tabler/icons-react";
import { formatChartValue } from "@/lib/rich-blocks";
import { refreshCadenceText, viewStaleness } from "@/lib/view-access";
import type { MetricPanelData } from "@/lib/view-spec";
import type { ViewSummary } from "@/lib/views";
import { cn } from "@/lib/utils";
import { formatAgo } from "./view-panels";

export function scopeText(view: { scopeType: string; scopeLabel: string | null }): string {
    if (view.scopeType === "company") return "Company";
    const noun = view.scopeType === "customer" ? "Client" : "Project";
    return view.scopeLabel ? `${noun}: ${view.scopeLabel}` : noun;
}

export function visibilityText(view: { visibility: string; sharedCount: number | null }): string {
    if (view.visibility === "private") return "Private";
    if (view.visibility === "shared") return view.sharedCount === null ? "Shared" : `Shared with ${view.sharedCount}`;
    return "Everyone in scope";
}

/** Private / Shared with N / Everyone in scope. */
export function VisibilityBadge({ view, className }: { view: { visibility: string; sharedCount: number | null }; className?: string }) {
    const Icon = view.visibility === "private" ? IconLock : view.visibility === "shared" ? IconUsers : IconWorld;
    return (
        <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground", className)}>
            <Icon className="h-3 w-3" aria-hidden />{visibilityText(view)}
        </span>
    );
}

function initials(name: string | null): string {
    const parts = (name ?? "?").trim().split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** A person as a small initials avatar plus name. */
export function PersonChip({ name, label, className }: { name: string | null; label?: string; className?: string }) {
    return (
        <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground", className)}>
            <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[9px] font-semibold text-foreground">{initials(name)}</span>
            <span className="truncate">{label ? `${label} ` : ""}{name ?? "Someone"}</span>
        </span>
    );
}

export function metricText(data: MetricPanelData): string {
    return typeof data.value === "number" ? formatChartValue(data.value, "", data.unit ?? "", true) : `${data.value}${data.unit ? ` ${data.unit}` : ""}`;
}

/** "Overdue: last updated 3 h ago (expected hourly)", or nothing when on time or no interval is set. */
export function StaleNote({ lastAt, since, refreshEveryMinutes, now, className, wrap = false }: {
    lastAt: string | null; since: string; refreshEveryMinutes: number | null; now: number; className?: string;
    /** Let the text wrap instead of truncating (narrow list columns). */
    wrap?: boolean;
}) {
    const stale = viewStaleness({ lastAt, since, refreshEveryMinutes }, now);
    if (!stale.overdue) return null;
    return (
        <span className={cn("inline-flex min-w-0 items-start gap-1 text-xs font-medium text-amber-400", className)} suppressHydrationWarning>
            <IconAlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className={wrap ? undefined : "truncate"}>Overdue: {stale.lastAt ? `last updated ${formatAgo(stale.lastAt, now)}` : "no values yet"} (expected {refreshCadenceText(stale.expectedMinutes)})</span>
        </span>
    );
}

/** One view in a list: title, key metric, freshness, visibility and owner. */
export function ViewRow({ view, now, showScope = true }: { view: ViewSummary; now: number; showScope?: boolean }) {
    const updated = view.dataUpdatedAt && view.dataUpdatedAt > view.updatedAt ? view.dataUpdatedAt : view.updatedAt;
    const metadata = view.access === "metadata";
    const maintainer = view.createdBy.type === "agent" ? view.createdBy.name : null;
    const overdue = !metadata && viewStaleness({ lastAt: view.dataUpdatedAt, since: view.createdAt, refreshEveryMinutes: view.refreshEveryMinutes }, now).overdue;
    return (
        <li>
            <Link href={`/views/${view.id}`} className="flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-accent/60 sm:flex-row sm:items-center sm:gap-4">
                <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
                        {view.archived && <IconArchive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Archived" />}
                        {view.pinned && <IconPin className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="Pinned to your Home" />}
                        <span className="truncate">{view.title}</span>
                    </span>
                    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                        <VisibilityBadge view={view} />
                        {view.owner && <PersonChip name={view.owner.name} />}
                        {showScope && <span className="truncate text-xs text-muted-foreground">{scopeText(view)}</span>}
                        {metadata && maintainer && <span className="truncate text-xs text-muted-foreground">Kept up to date by {maintainer}</span>}
                    </span>
                </span>
                {metadata ? (
                    <span className="text-xs text-muted-foreground sm:w-64 sm:text-right" suppressHydrationWarning>
                        {view.visibility === "shared" ? "Owner and shared people only" : "Owner only"} · updated {formatAgo(view.updatedAt, now)}
                    </span>
                ) : (
                    <span className="flex min-w-0 flex-col gap-0.5 sm:w-64 sm:items-end">
                        {view.keyMetric ? (
                            <span className="flex min-w-0 max-w-full items-baseline gap-1.5 sm:justify-end">
                                <span className="truncate text-xs text-muted-foreground">{view.keyMetric.title}</span>
                                <span className="shrink-0 text-base font-semibold text-foreground tabular-nums">{metricText(view.keyMetric.data)}</span>
                            </span>
                        ) : (
                            <span className="text-xs text-muted-foreground">{view.panelCount} panel{view.panelCount === 1 ? "" : "s"}</span>
                        )}
                        {overdue ? (
                            <StaleNote lastAt={view.dataUpdatedAt} since={view.createdAt} refreshEveryMinutes={view.refreshEveryMinutes} now={now} wrap className="sm:justify-end sm:text-right" />
                        ) : (
                            <span className="truncate text-xs text-muted-foreground" suppressHydrationWarning>
                                Updated {formatAgo(updated, now)}{maintainer ? ` · ${maintainer}` : ""}
                            </span>
                        )}
                    </span>
                )}
            </Link>
        </li>
    );
}
