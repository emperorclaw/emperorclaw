"use client";

import React from "react";
import Link from "next/link";
import { IconCalendarDue, IconChecklist, IconFolder, IconRobot, IconUser } from "@tabler/icons-react";
import { entityTone, humanizeState, type EntityRef, type EntitySummary } from "@/lib/emperor-entities";
import { cn } from "@/lib/utils";
import { useEmperorEntity } from "./use-emperor-entities";

const KIND_ICON = { task: IconChecklist, project: IconFolder, agent: IconRobot } as const;

const TONE_DOT = {
    positive: "bg-emerald-400",
    active: "bg-cyan-400 animate-pulse",
    warning: "bg-amber-400",
    negative: "bg-rose-400",
    muted: "bg-zinc-500",
} as const;

const TONE_BADGE = {
    positive: "bg-emerald-500/12 text-emerald-400 ring-emerald-500/25",
    active: "bg-cyan-500/12 text-cyan-300 ring-cyan-500/25",
    warning: "bg-amber-500/12 text-amber-300 ring-amber-500/25",
    negative: "bg-rose-500/12 text-rose-300 ring-rose-500/25",
    muted: "bg-zinc-500/12 text-zinc-400 ring-zinc-500/25",
} as const;

function stateLabel(summary: EntitySummary): string {
    return humanizeState(summary.kind === "task" ? summary.state : summary.status);
}

function relativeTime(iso: string | null): string | null {
    if (!iso) return null;
    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return null;
    const future = diff < 0;
    const minutes = Math.round(Math.abs(diff) / 60_000);
    const text = minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : minutes < 60 * 24 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
    if (text === "now") return "just now";
    return future ? `in ${text}` : `${text} ago`;
}

/** Inline record reference: icon, live title, and a status dot. */
export function EntityChip({ entityRef, label }: { entityRef: EntityRef; label: string }) {
    const { value, status } = useEmperorEntity(entityRef);
    const Icon = KIND_ICON[entityRef.kind];
    const title = value?.title || label || entityRef.kind;
    const unavailable = status !== "loading" && !value;
    const content = (
        <>
            <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <span className="max-w-[16rem] truncate">{title}</span>
            {value && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[entityTone(value)])} aria-hidden />}
        </>
    );
    const className = cn(
        "not-prose mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border px-1.5 py-0.5 align-[-0.2em] text-[0.9em] font-medium no-underline transition-colors",
        unavailable
            ? "border-dashed border-zinc-700 text-zinc-500"
            : "border-zinc-700/80 bg-zinc-800/50 text-zinc-100 hover:border-zinc-500 hover:bg-zinc-800",
    );
    const tooltip = value ? `${title} · ${stateLabel(value)}` : unavailable ? `${label} (not available)` : label;
    if (!value) return <span className={className} title={tooltip}>{content}</span>;
    return <Link href={value.href} className={className} title={tooltip}>{content}</Link>;
}

function CardShell({ href, children }: { href?: string; children: React.ReactNode }) {
    const className = "ec-rich-rise group/entity flex min-w-0 flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-3 no-underline transition-colors";
    return href
        ? <Link href={href} className={cn(className, "hover:border-zinc-600 hover:bg-zinc-900")}>{children}</Link>
        : <div className={className}>{children}</div>;
}

/** A full card for a record linked on a line of its own. */
export function EntityCard({ entityRef, label }: { entityRef: EntityRef; label: string }) {
    const { value, status } = useEmperorEntity(entityRef);
    const Icon = KIND_ICON[entityRef.kind];

    if (!value) {
        return (
            <CardShell>
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                    <Icon className="h-4 w-4" />
                    <span className="truncate">{label || entityRef.kind}</span>
                </div>
                {status === "loading"
                    ? <div className="h-3 w-24 animate-pulse rounded bg-zinc-800" />
                    : <div className="text-xs text-zinc-600">Not available: deleted, or outside your access.</div>}
            </CardShell>
        );
    }

    const tone = entityTone(value);
    return (
        <CardShell href={value.href}>
            <div className="flex min-w-0 items-start gap-2.5">
                {value.kind === "agent" && value.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={value.avatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-full border border-zinc-700 bg-zinc-800 object-cover" />
                ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-zinc-400">
                        <Icon className="h-4 w-4" />
                    </span>
                )}
                <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-sm font-semibold leading-snug text-zinc-100 group-hover/entity:text-zinc-50">{value.title}</div>
                    <div className="mt-0.5 truncate text-xs text-zinc-500">
                        {value.kind === "task" && (value.project || "Task")}
                        {value.kind === "project" && (value.lead ? `Lead: ${value.lead}` : "Project")}
                        {value.kind === "agent" && (value.role || "Agent")}
                    </div>
                </div>
                <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", TONE_BADGE[tone])}>
                    {stateLabel(value)}
                </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
                {value.kind === "task" && (
                    <>
                        <span className="inline-flex items-center gap-1"><IconUser className="h-3.5 w-3.5 text-zinc-500" />{value.assignee || "Unassigned"}</span>
                        {value.dueAt && <span className="inline-flex items-center gap-1"><IconCalendarDue className="h-3.5 w-3.5 text-zinc-500" />Due {relativeTime(value.dueAt)}</span>}
                        <span className="text-zinc-600">Updated {relativeTime(value.updatedAt)}</span>
                    </>
                )}
                {value.kind === "project" && (() => {
                    const total = value.openTasks + value.doneTasks;
                    const pct = total > 0 ? Math.round((value.doneTasks / total) * 100) : 0;
                    return (
                        <div className="flex w-full items-center gap-2.5">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                                <div className="h-full rounded-full bg-[var(--chart-2)]" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="shrink-0 tabular-nums">{value.doneTasks}/{total} done</span>
                        </div>
                    );
                })()}
                {value.kind === "agent" && (
                    <>
                        <span className="tabular-nums">{value.openTasks} open task{value.openTasks === 1 ? "" : "s"}</span>
                        <span className="tabular-nums">Load {value.load}</span>
                        {value.lastSeenAt && <span className="text-zinc-600">Seen {relativeTime(value.lastSeenAt)}</span>}
                    </>
                )}
            </div>
        </CardShell>
    );
}

export function EntityCardGrid({ items }: { items: { entityRef: EntityRef; label: string }[] }) {
    return (
        <div className={cn("not-prose my-3 grid w-full min-w-0 gap-2", items.length > 1 && "sm:grid-cols-2")}>
            {items.map((item, i) => <EntityCard key={`${item.entityRef.kind}:${item.entityRef.id}:${i}`} {...item} />)}
        </div>
    );
}
