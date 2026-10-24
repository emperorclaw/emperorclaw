"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    IconCalendar,
    IconChartLine,
    IconChevronRight,
    IconMinus,
    IconPlus,
} from "@tabler/icons-react";
import { PageHeader } from "@/components/page-header";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatCost, RUN_OUTCOME_LABEL, taskHref, type RunOutcome } from "@/lib/task-story";
import { formatRunDuration, formatTokenCount } from "@/lib/run-ledger-copy";
import { useLivePoll, type LivePollRun } from "@/lib/use-realtime";
import { cn } from "@/lib/utils";
import {
    EDGE_KIND_LABEL,
    EVENT_KIND_LABEL,
    type TimelineActor,
    type TimelineEdge,
    type TimelineEventKind,
    type TimelineSpan,
    type WorkTimeline,
} from "@/lib/work-timeline";

const DAY_MS = 86_400_000;
const ROW_H = 44;
const LABEL_W = 208;
const AXIS_H = 30;
const ZOOM_PX_PER_DAY = [48, 96, 192, 384, 768];
const DEFAULT_ZOOM = 1;
const LIVE_TOPICS = ["agents", "projects"] as const;

type FilterOption = { value: string; label: string; description?: string | null };

const OUTCOME_FILL: Record<RunOutcome, string> = {
    running: "rgba(34,211,238,0.18)",
    done: "rgba(16,185,129,0.32)",
    needs_you: "rgba(245,158,11,0.32)",
    failed: "rgba(244,63,94,0.32)",
    stopped: "rgba(113,113,122,0.28)",
};
const OUTCOME_STROKE: Record<RunOutcome, string> = {
    running: "rgba(34,211,238,0.75)",
    done: "rgba(52,211,153,0.85)",
    needs_you: "rgba(251,191,36,0.85)",
    failed: "rgba(251,113,133,0.85)",
    stopped: "rgba(113,113,122,0.85)",
};
const OUTCOME_TEXT: Record<RunOutcome, string> = {
    running: "text-cyan-300",
    done: "text-emerald-300",
    needs_you: "text-amber-300",
    failed: "text-rose-300",
    stopped: "text-zinc-400",
};

const EVENT_COLOUR: Record<TimelineEventKind, string> = {
    created: "#22d3ee",
    assigned: "#a78bfa",
    status: "#94a3b8",
    note: "#e2e8f0",
    approval_requested: "#fbbf24",
    approval_decided: "#34d399",
    file: "#38bdf8",
};

function formatBusy(ms: number): string {
    if (ms <= 0) return "0m";
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatRange(ms: number): string {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(ms));
}

function formatClock(ms: number): string {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: false }).format(new Date(ms));
}

// ─── Ticks ──────────────────────────────────────────────────────────────────

const TICK_INTERVALS = [3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, DAY_MS, 2 * DAY_MS, 7 * DAY_MS];

function computeTicks(fromMs: number, toMs: number, pxPerMs: number): { intervalMs: number; ticks: number[] } {
    const intervalMs = TICK_INTERVALS.find((iv) => iv * pxPerMs >= 80) ?? 7 * DAY_MS;
    const ticks: number[] = [];
    const start = Math.ceil(fromMs / intervalMs) * intervalMs;
    for (let t = start; t <= toMs; t += intervalMs) ticks.push(t);
    return { intervalMs, ticks };
}

function tickLabel(ms: number, intervalMs: number): string {
    const d = new Date(ms);
    if (intervalMs >= DAY_MS) {
        return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
    }
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false }).format(d);
}

// ─── Range presets ──────────────────────────────────────────────────────────

type Preset = "today" | "7d" | "30d" | "custom";

function presetRange(preset: Preset, now = new Date()): { fromMs: number; toMs: number } {
    const toMs = now.getTime();
    if (preset === "today") {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        return { fromMs: start, toMs };
    }
    if (preset === "7d") return { fromMs: toMs - 7 * DAY_MS, toMs };
    if (preset === "30d") return { fromMs: toMs - 30 * DAY_MS, toMs };
    return { fromMs: toMs - 7 * DAY_MS, toMs };
}

function localDayMs(value: string): number | null {
    const d = new Date(`${value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
}

// ─── Client ─────────────────────────────────────────────────────────────────

export function TimelineClient({ initial, initialFilter, agents, projects, customers }: {
    initial: WorkTimeline;
    initialFilter?: { agentId?: string; projectId?: string; customerId?: string };
    agents: FilterOption[];
    projects: FilterOption[];
    customers: FilterOption[];
}) {
    const router = useRouter();
    const [range, setRange] = useState<{ preset: Preset; fromMs: number; toMs: number }>({ preset: "7d", fromMs: initial.from, toMs: initial.to });
    const [customFrom, setCustomFrom] = useState("");
    const [customTo, setCustomTo] = useState("");
    const [filters, setFilters] = useState<{ agentId: string; projectId: string; customerId: string }>({
        agentId: initialFilter?.agentId ?? "",
        projectId: initialFilter?.projectId ?? "",
        customerId: initialFilter?.customerId ?? "",
    });
    const [zoom, setZoom] = useState(DEFAULT_ZOOM);
    const [data, setData] = useState<WorkTimeline>(initial);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [tooltip, setTooltip] = useState<{ x: number; y: number; node: React.ReactNode } | null>(null);
    const [scrollLeft, setScrollLeft] = useState(0);
    const [viewport, setViewport] = useState(0);

    const pxPerMs = ZOOM_PX_PER_DAY[zoom] / DAY_MS;
    const chartWidth = Math.max(1, Math.round((range.toMs - range.fromMs) * pxPerMs));
    const xFor = (ms: number) => (ms - range.fromMs) * pxPerMs;

    const query = useMemo(() => {
        const params = new URLSearchParams({ from: String(range.fromMs), to: String(range.toMs) });
        if (filters.agentId) params.set("agentId", filters.agentId);
        if (filters.projectId) params.set("projectId", filters.projectId);
        if (filters.customerId) params.set("customerId", filters.customerId);
        return params.toString();
    }, [range.fromMs, range.toMs, filters.agentId, filters.projectId, filters.customerId]);

    // `run.active` turns false once this query is superseded, so a slow
    // response for an old range never overwrites the current one.
    const load = useCallback(async (run: LivePollRun) => {
        setLoading(true);
        try {
            const res = await fetch(`/api/timeline?${query}`, { cache: "no-store" });
            if (!res.ok) {
                const body = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(body.error || "Could not load the timeline");
            }
            const next = await res.json() as WorkTimeline;
            if (!run.active) return;
            setData(next);
            setError(null);
        } catch (err) {
            if (run.active && !(err instanceof DOMException && err.name === "AbortError")) {
                setError(err instanceof Error ? err.message : "Could not load the timeline");
            }
        } finally {
            if (run.active) setLoading(false);
        }
    }, [query]);

    // Live while today is in range: one poll (fast while the socket is down,
    // slow while it is up), a throttled refetch on realtime invalidations, and
    // never two requests in flight. A past range loads once per change.
    const startOfToday = useMemo(() => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime(), []);
    const includesToday = range.toMs >= startOfToday;
    useLivePoll(load, {
        fastMs: 30_000,
        topics: LIVE_TOPICS,
        enabled: includesToday,
        resetKey: query,
        throttleMs: 5_000,
    });
    useEffect(() => {
        if (includesToday) return;
        const run = { active: true };
        void load(run);
        return () => { run.active = false; };
    }, [includesToday, load]);

    const setPreset = (preset: Preset) => {
        setRange({ preset, ...presetRange(preset) });
    };

    const applyCustom = () => {
        const from = localDayMs(customFrom);
        const to = customTo ? localDayMs(customTo) : null;
        if (from == null) return;
        const toMs = to ? to + DAY_MS : Date.now();
        if (toMs <= from) return;
        setRange({ preset: "custom", fromMs: from, toMs });
    };

    const hasFilter = Boolean(filters.agentId || filters.projectId || filters.customerId);
    const clearFilters = () => setFilters({ agentId: "", projectId: "", customerId: "" });

    const actorById = useMemo(() => new Map(data.actors.map((a) => [a.id, a])), [data.actors]);
    const rowIndex = useMemo(() => new Map(data.actors.map((a, i) => [a.id, i])), [data.actors]);
    const spansByActor = useMemo(() => {
        const map = new Map<string, TimelineSpan[]>();
        for (const s of data.spans) {
            const list = map.get(s.actorId) ?? [];
            list.push(s);
            map.set(s.actorId, list);
        }
        return map;
    }, [data.spans]);
    const eventsByActor = useMemo(() => {
        const map = new Map<string, { kind: TimelineEventKind; at: number; taskId: string }[]>();
        for (const e of data.events) {
            const list = map.get(e.actorId) ?? [];
            list.push({ kind: e.kind, at: e.at, taskId: e.taskId });
            map.set(e.actorId, list);
        }
        return map;
    }, [data.events]);

    const windowMs = range.toMs - range.fromMs;

    const openSpan = useCallback((span: TimelineSpan) => {
        if (span.href) router.push(span.href);
    }, [router]);

    const handleScroll = useCallback((left: number, vp: number) => {
        setScrollLeft(left);
        setViewport(vp);
    }, []);

    return (
        <div className="mx-auto w-full max-w-[1200px] space-y-5 pb-20">
            <PageHeader
                eyebrow="Timeline"
                title="Who worked on what"
                description="One row per agent and person: when they were busy, on what, and who handed work to whom."
            />

            {/* Range presets + filters + zoom */}
            <div className="flex flex-wrap items-center gap-2">
                <div role="toolbar" aria-label="Time range" className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-950/40 p-1">
                    {(["today", "7d", "30d"] as Preset[]).map((preset) => (
                        <button key={preset} type="button" aria-pressed={range.preset === preset} onClick={() => setPreset(preset)}
                            className={cn("rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                                range.preset === preset ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200")}>
                            {preset === "today" ? "Today" : preset === "7d" ? "7 days" : "30 days"}
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950/40 p-1.5">
                    <IconCalendar className="h-4 w-4 text-zinc-500" />
                    <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} aria-label="From date" className="bg-transparent text-xs text-zinc-200 outline-none" />
                    <span className="text-zinc-600">–</span>
                    <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} aria-label="To date" className="bg-transparent text-xs text-zinc-200 outline-none" />
                    <button type="button" onClick={applyCustom} disabled={!customFrom} className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-100 disabled:opacity-50">Apply</button>
                </div>
                <span className="hidden text-xs text-zinc-500 sm:inline">{formatRange(range.fromMs)} – {formatRange(range.toMs)}</span>

                <div className="ml-auto flex items-center gap-1.5">
                    <div className="hidden flex-wrap items-center gap-1.5 lg:flex">
                        <SearchableSelect value={filters.agentId} onChange={(v) => setFilters((f) => ({ ...f, agentId: v }))}
                            options={[{ value: "", label: "All agents" }, ...agents]} placeholder="All agents" className="min-w-[150px]" />
                        <SearchableSelect value={filters.projectId} onChange={(v) => setFilters((f) => ({ ...f, projectId: v }))}
                            options={[{ value: "", label: "All projects" }, ...projects]} placeholder="All projects" className="min-w-[150px]" />
                        <SearchableSelect value={filters.customerId} onChange={(v) => setFilters((f) => ({ ...f, customerId: v }))}
                            options={[{ value: "", label: "All customers" }, ...customers]} placeholder="All customers" className="min-w-[150px]" />
                        {hasFilter && <button type="button" onClick={clearFilters} className="rounded-lg px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">Clear</button>}
                    </div>
                    <div className="flex items-center gap-0.5 rounded-xl border border-zinc-800 bg-zinc-950/40 p-1">
                        <button type="button" onClick={() => setZoom((z) => Math.max(0, z - 1))} disabled={zoom === 0} aria-label="Zoom out" className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"><IconMinus className="h-4 w-4" /></button>
                        <button type="button" onClick={() => setZoom(DEFAULT_ZOOM)} aria-label="Reset zoom" className="rounded-lg px-2 py-1.5 text-[11px] font-medium text-zinc-400 hover:text-zinc-200">Reset</button>
                        <button type="button" onClick={() => setZoom((z) => Math.min(ZOOM_PX_PER_DAY.length - 1, z + 1))} disabled={zoom === ZOOM_PX_PER_DAY.length - 1} aria-label="Zoom in" className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"><IconPlus className="h-4 w-4" /></button>
                    </div>
                </div>
            </div>

            {/* Totals strip */}
            <dl className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                <Total label="Runs" value={String(data.totals.runs)} />
                <Total label="Busy time" value={formatBusy(data.totals.busyMs)} />
                <Total label="Tokens" value={formatTokenCount(data.totals.tokens)} />
                <Total label="Cost" value={formatCost(data.totals.costCents) ?? "$0.00"} />
            </dl>

            {error && (
                <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p>
            )}
            {data.capped && (
                <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                    This window has more activity than the chart can draw. Narrow the range or use the filters.
                </p>
            )}

            {/* Desktop: Gantt */}
            <div className={cn("hidden md:block", loading && "opacity-60 transition-opacity")}>
                <GanttChart
                    data={data}
                    fromMs={range.fromMs}
                    toMs={range.toMs}
                    pxPerMs={pxPerMs}
                    chartWidth={chartWidth}
                    xFor={xFor}
                    spansByActor={spansByActor}
                    eventsByActor={eventsByActor}
                    actorById={actorById}
                    rowIndex={rowIndex}
                    windowMs={windowMs}
                    scrollLeft={scrollLeft}
                    viewport={viewport}
                    onScroll={handleScroll}
                    onOpen={openSpan}
                    setTooltip={setTooltip}
                />
            </div>

            {/* Phone: per-actor list */}
            <div className="md:hidden">
                <PhoneList data={data} spansByActor={spansByActor} onOpen={openSpan} />
            </div>

            {/* Legend + hints */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-500">
                <span className="font-semibold uppercase tracking-wide text-zinc-600">Legend</span>
                {(["done", "needs_you", "failed", "stopped", "running"] as RunOutcome[]).map((o) => (
                    <span key={o} className="inline-flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: OUTCOME_STROKE[o] }} />
                        {RUN_OUTCOME_LABEL[o]}
                    </span>
                ))}
                <span className="ml-auto hidden items-center gap-1.5 lg:inline-flex"><kbd className="rounded border border-zinc-700 px-1 font-mono text-[10px]">Enter</kbd> opens a bar&apos;s task or chat</span>
            </div>

            {tooltip && (
                <div className="pointer-events-none fixed z-50 max-w-xs rounded-xl border border-zinc-700 bg-zinc-950/95 px-3 py-2 shadow-2xl"
                    style={{ left: Math.min(tooltip.x + 12, window.innerWidth - 300), top: tooltip.y + 12 }}>
                    {tooltip.node}
                </div>
            )}
        </div>
    );
}

function Total({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/40 px-4 py-3">
            <dt className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</dt>
            <dd className="mt-0.5 truncate font-mono text-lg font-semibold tabular-nums text-zinc-100">{value}</dd>
        </div>
    );
}

// ─── Gantt ──────────────────────────────────────────────────────────────────

function GanttChart({ data, fromMs, toMs, pxPerMs, chartWidth, xFor, spansByActor, eventsByActor, actorById, rowIndex, windowMs, scrollLeft, viewport, onScroll, onOpen, setTooltip }: {
    data: WorkTimeline;
    fromMs: number;
    toMs: number;
    pxPerMs: number;
    chartWidth: number;
    xFor: (ms: number) => number;
    spansByActor: Map<string, TimelineSpan[]>;
    eventsByActor: Map<string, { kind: TimelineEventKind; at: number; taskId: string }[]>;
    actorById: Map<string, TimelineActor>;
    rowIndex: Map<string, number>;
    windowMs: number;
    scrollLeft: number;
    viewport: number;
    onScroll: (left: number, viewport: number) => void;
    onOpen: (span: TimelineSpan) => void;
    setTooltip: (t: { x: number; y: number; node: React.ReactNode } | null) => void;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const totalWidth = LABEL_W + chartWidth;
    const { intervalMs, ticks } = computeTicks(fromMs, toMs, pxPerMs);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        onScroll(el.scrollLeft, Math.max(1, el.clientWidth - LABEL_W));
    }, [chartWidth, data.actors.length, onScroll]);

    const nowX = xFor(data.now);

    const handleScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        onScroll(el.scrollLeft, Math.max(1, el.clientWidth - LABEL_W));
    };

    return (
        <div className="overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/40">
            {data.actors.length === 0 ? (
                <div className="px-5 py-14 text-center">
                    <IconChartLine className="mx-auto h-8 w-8 text-zinc-600" />
                    <p className="mt-3 text-sm text-zinc-300">Nothing happened in this window.</p>
                    <p className="mt-1 text-xs text-zinc-500">Try a wider range, or clear the filters.</p>
                </div>
            ) : (
                <>
                    <div ref={scrollRef} onScroll={handleScroll} className="timeline-scroll max-h-[62vh] overflow-auto overscroll-x-contain">
                        <div className="relative" style={{ width: totalWidth }}>
                            {/* Axis header */}
                            <div className="sticky top-0 z-30 flex" style={{ height: AXIS_H }}>
                                <div className="sticky left-0 z-40 shrink-0 border-b border-r border-zinc-800 bg-zinc-950" style={{ width: LABEL_W }} />
                                <div className="relative shrink-0 border-b border-zinc-800 bg-zinc-950/95" style={{ width: chartWidth }}>
                                    {ticks.map((t) => (
                                        <span key={t} className="absolute top-0 flex h-full items-center font-mono text-[10px] text-zinc-500" style={{ left: xFor(t), transform: "translateX(-50%)" }}>
                                            {tickLabel(t, intervalMs)}
                                        </span>
                                    ))}
                                </div>
                            </div>

                            {/* Rows */}
                            {data.actors.map((actor, i) => (
                                <div key={actor.id} className="flex" style={{ height: ROW_H }}>
                                    <div className="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-b border-r border-zinc-800/80 bg-zinc-950 px-3" style={{ width: LABEL_W }}>
                                        <ActorAvatar actor={actor} />
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-sm font-medium text-zinc-100">{actor.name}</div>
                                            <div className="truncate text-[11px] text-zinc-500">{actor.runCount} runs · {Math.round((actor.busyMs / Math.max(1, windowMs)) * 100)}% busy</div>
                                        </div>
                                    </div>
                                    <div className="relative shrink-0 border-b border-zinc-800/50" style={{ width: chartWidth }}>
                                        <svg width={chartWidth} height={ROW_H} className="block" role="presentation">
                                            <RowContent
                                                actor={actor}
                                                i={i}
                                                spans={spansByActor.get(actor.id) ?? []}
                                                events={eventsByActor.get(actor.id) ?? []}
                                                xFor={xFor}
                                                onOpen={onOpen}
                                                setTooltip={setTooltip}
                                            />
                                        </svg>
                                    </div>
                                </div>
                            ))}

                            {/* Overlay: edges + now line */}
                            <div className="pointer-events-none absolute" style={{ left: LABEL_W, top: AXIS_H, width: chartWidth, height: data.actors.length * ROW_H }}>
                                <svg width={chartWidth} height={data.actors.length * ROW_H} className="block">
                                    {data.now >= fromMs && data.now <= toMs && (
                                        <g>
                                            <line x1={nowX} x2={nowX} y1={0} y2={data.actors.length * ROW_H} stroke="rgba(34,211,238,0.55)" strokeDasharray="3 3" strokeWidth={1} />
                                            <rect x={nowX - 16} y={0} width={32} height={14} rx={7} fill="rgba(34,211,238,0.9)" />
                                            <text x={nowX} y={10} textAnchor="middle" fontSize={9} fill="#04252b" fontWeight={600}>now</text>
                                        </g>
                                    )}
                                    {data.edges.map((edge) => (
                                        <EdgePath key={edge.id} edge={edge} rowIndex={rowIndex} xFor={xFor} colour={actorById.get(edge.from)?.colour} />
                                    ))}
                                </svg>
                            </div>
                        </div>
                    </div>

                    {/* Mini-map / brush */}
                    <Minimap
                        data={data}
                        fromMs={fromMs}
                        toMs={toMs}
                        chartWidth={chartWidth}
                        scrollLeft={scrollLeft}
                        viewport={viewport}
                        onSeek={(left) => { const el = scrollRef.current; if (el) el.scrollLeft = left; }}
                    />
                </>
            )}
        </div>
    );
}

function ActorAvatar({ actor }: { actor: TimelineActor }) {
    if (actor.avatarUrl) {
        return (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={actor.avatarUrl} alt="" className="h-7 w-7 shrink-0 rounded-full ring-1 ring-zinc-700" />
        );
    }
    return (
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-zinc-100 ring-1 ring-zinc-700" style={{ backgroundColor: actor.colour }}>
            {actor.initials}
        </span>
    );
}

function RowContent({ actor, i, spans, events, xFor, onOpen, setTooltip }: {
    actor: TimelineActor;
    i: number;
    spans: TimelineSpan[];
    events: { kind: TimelineEventKind; at: number; taskId: string }[];
    xFor: (ms: number) => number;
    onOpen: (span: TimelineSpan) => void;
    setTooltip: (t: { x: number; y: number; node: React.ReactNode } | null) => void;
}) {
    const y = ROW_H / 2;
    const stripeId = `tl-stripe-${i}`;
    return (
        <>
            <defs>
                <pattern id={stripeId} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="3" height="7" fill="rgba(34,211,238,0.5)" />
                </pattern>
            </defs>
            {spans.map((span) => {
                const x = xFor(span.start);
                const width = Math.max(3, xFor(span.end) - xFor(span.start));
                const cancelled = span.status === "cancelled";
                const fill = cancelled ? "transparent" : span.running ? `url(#${stripeId})` : OUTCOME_FILL[span.outcome];
                const stroke = OUTCOME_STROKE[span.outcome];
                const showTooltip = (e: React.MouseEvent | React.FocusEvent) => {
                    const rect = (e.currentTarget as Element).getBoundingClientRect();
                    setTooltip({ x: rect.left + rect.width / 2, y: rect.top, node: <SpanTooltip span={span} actorName={actor.name} /> });
                };
                const rect = (
                    <rect x={x} y={8} width={width} height={ROW_H - 16} rx={4}
                        fill={fill} stroke={stroke} strokeWidth={1}
                        strokeDasharray={cancelled ? "4 3" : undefined}
                        className={cn(span.running && "animate-pulse")} />
                );
                return span.href ? (
                    <a key={span.id} href={span.href} onClick={(e) => { e.preventDefault(); onOpen(span); }}
                        onMouseEnter={(e) => showTooltip(e)} onMouseLeave={() => setTooltip(null)}
                        onFocus={(e) => showTooltip(e)} onBlur={() => setTooltip(null)}
                        aria-label={`${span.taskTitle ?? "Chat"}: ${RUN_OUTCOME_LABEL[span.outcome]}`}
                    >
                        {rect}
                    </a>
                ) : (
                    <g key={span.id} onMouseEnter={(e) => showTooltip(e)} onMouseLeave={() => setTooltip(null)}>{rect}</g>
                );
            })}
            {events.map((ev, i) => (
                <a key={`${ev.kind}:${ev.taskId}:${ev.at}:${i}`} href={taskHref(ev.taskId)} tabIndex={-1}
                    onMouseEnter={(e) => {
                        const rect = (e.currentTarget as Element).getBoundingClientRect();
                        setTooltip({ x: rect.left, y: rect.top, node: <span className="text-xs text-zinc-200">{EVENT_KIND_LABEL[ev.kind]}</span> });
                    }}
                    onMouseLeave={() => setTooltip(null)}>
                    <EventMarker kind={ev.kind} cx={xFor(ev.at)} cy={y} />
                    <title>{EVENT_KIND_LABEL[ev.kind]}</title>
                </a>
            ))}
        </>
    );
}

function EventMarker({ kind, cx, cy }: { kind: TimelineEventKind; cx: number; cy: number }) {
    const colour = EVENT_COLOUR[kind];
    const r = 4;
    if (kind === "assigned") {
        return <path d={`M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`} fill={colour} stroke="rgba(0,0,0,0.5)" strokeWidth={1} />;
    }
    if (kind === "approval_requested" || kind === "approval_decided") {
        const dir = kind === "approval_requested" ? -1 : 1;
        return <path d={`M ${cx} ${cy + dir * r} L ${cx - r} ${cy - dir * r} L ${cx + r} ${cy - dir * r} Z`} fill={colour} />;
    }
    if (kind === "file") {
        return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={1} fill={colour} />;
    }
    if (kind === "created") {
        return <circle cx={cx} cy={cy} r={r} fill="none" stroke={colour} strokeWidth={1.5} />;
    }
    return <circle cx={cx} cy={cy} r={r - 0.5} fill={colour} />;
}

function EdgePath({ edge, rowIndex, xFor, colour }: { edge: TimelineEdge; rowIndex: Map<string, number>; xFor: (ms: number) => number; colour: string | undefined }) {
    const from = rowIndex.get(edge.from);
    const to = rowIndex.get(edge.to);
    if (from == null || to == null) return null;
    const x = xFor(edge.at);
    const y1 = from * ROW_H + ROW_H / 2;
    const y2 = to * ROW_H + ROW_H / 2;
    const dy = y2 - y1;
    const bulge = Math.min(48, Math.max(24, Math.abs(dy) * 0.35));
    const d = `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x} ${y2}`;
    const stroke = colour ?? "rgba(148,163,184,0.7)";
    return (
        <g>
            <path d={d} fill="none" stroke={stroke} strokeWidth={1.25} strokeOpacity={0.55} />
            <path d={`M ${x - 3.5} ${y2 + (dy >= 0 ? -5 : 5)} L ${x} ${y2} L ${x + 3.5} ${y2 + (dy >= 0 ? -5 : 5)}`} fill="none" stroke={stroke} strokeWidth={1.25} />
            <title>{EDGE_KIND_LABEL[edge.kind]}</title>
        </g>
    );
}

function Minimap({ data, fromMs, toMs, chartWidth, scrollLeft, viewport, onSeek }: {
    data: WorkTimeline;
    fromMs: number;
    toMs: number;
    chartWidth: number;
    scrollLeft: number;
    viewport: number;
    onSeek: (left: number) => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const height = 40;
    const labelGap = LABEL_W;
    const plotWidth = chartWidth;
    const xMini = (ms: number) => (ms - fromMs) / (toMs - fromMs) * plotWidth;
    const dragRef = useRef(false);

    const seek = (clientX: number) => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (clientX - rect.left - labelGap) / plotWidth));
        const center = frac * chartWidth;
        onSeek(Math.max(0, Math.min(chartWidth, center - viewport / 2)));
    };

    return (
        <div ref={ref} className="relative hidden border-t border-zinc-800/80 bg-zinc-950/60 md:block"
            style={{ height: height + 8 }}
            onPointerDown={(e) => { dragRef.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); seek(e.clientX); }}
            onPointerMove={(e) => { if (dragRef.current) seek(e.clientX); }}
            onPointerUp={() => { dragRef.current = false; }}
            onPointerCancel={() => { dragRef.current = false; }}
        >
            <div className="absolute" style={{ left: labelGap, top: 4, width: plotWidth, height }}>
                <svg width={plotWidth} height={height}>
                    {data.spans.map((s) => {
                        const x = xMini(s.start);
                        const w = Math.max(1.5, xMini(s.end) - xMini(s.start));
                        return <rect key={s.id} x={x} y={12} width={w} height={height - 24} fill={OUTCOME_STROKE[s.outcome]} opacity={0.5} />;
                    })}
                </svg>
            </div>
            {/* Brush */}
            <div className="absolute top-0 rounded ring-1 ring-cyan-400/60 bg-cyan-400/10" style={{
                left: labelGap + (scrollLeft / chartWidth) * plotWidth,
                width: Math.max(24, (viewport / chartWidth) * plotWidth),
                height: height + 8,
            }} />
        </div>
    );
}

// ─── Tooltip + phone list ───────────────────────────────────────────────────

function SpanTooltip({ span, actorName }: { span: TimelineSpan; actorName: string }) {
    const parts = [formatRunDuration(span.durationMs)];
    if (span.toolCalls != null) parts.push(`${span.toolCalls} ${span.toolCalls === 1 ? "tool" : "tools"}`);
    if (span.tokens > 0) parts.push(`${formatTokenCount(span.tokens)} tokens`);
    const cost = formatCost(span.costCents);
    if (cost) parts.push(cost);
    return (
        <div className="space-y-0.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                <span className={OUTCOME_TEXT[span.outcome]}>{RUN_OUTCOME_LABEL[span.outcome]}</span>
                <span>·</span>
                <span>{actorName}</span>
            </div>
            <div className="text-sm font-medium text-zinc-100">{span.taskTitle ?? (span.threadLabel ?? "Chat")}</div>
            {span.projectName && <div className="text-xs text-zinc-400">{span.projectName}</div>}
            <div className="text-xs text-zinc-400">
                {formatClock(span.startedAtMs)} – {span.endedAtMs ? formatClock(span.endedAtMs) : "now"}
            </div>
            <div className="text-xs tabular-nums text-zinc-500">{parts.filter(Boolean).join(" · ")}</div>
        </div>
    );
}

function PhoneList({ data, spansByActor, onOpen }: {
    data: WorkTimeline;
    spansByActor: Map<string, TimelineSpan[]>;
    onOpen: (span: TimelineSpan) => void;
}) {
    if (data.actors.length === 0) {
        return <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/40 px-5 py-12 text-center text-sm text-zinc-400">Nothing happened in this window.</div>;
    }
    return (
        <div className="space-y-5">
            {data.actors.map((actor) => {
                const spans = (spansByActor.get(actor.id) ?? []).slice().sort((a, b) => b.start - a.start);
                if (spans.length === 0) return null;
                return (
                    <section key={actor.id} aria-label={actor.name}>
                        <header className="mb-2 flex items-center gap-2 px-1">
                            <ActorAvatar actor={actor} />
                            <span className="text-sm font-semibold text-zinc-100">{actor.name}</span>
                            <span className="ml-auto text-xs text-zinc-500">{actor.runCount} runs</span>
                        </header>
                        <ul className="space-y-2">
                            {spans.map((span) => (
                                <li key={span.id}>
                                    <button type="button" onClick={() => onOpen(span)} disabled={!span.href}
                                        className="flex w-full items-center gap-3 rounded-xl border border-zinc-800/80 bg-zinc-950/40 px-3 py-2 text-left disabled:cursor-default">
                                        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", span.outcome === "running" && "animate-pulse")} style={{ backgroundColor: OUTCOME_STROKE[span.outcome] }} />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm text-zinc-100">{span.taskTitle ?? span.threadLabel ?? "Chat"}</span>
                                            <span className="block truncate text-xs text-zinc-500">{formatClock(span.startedAtMs)} – {span.endedAtMs ? formatClock(span.endedAtMs) : "now"} · {RUN_OUTCOME_LABEL[span.outcome]}</span>
                                        </span>
                                        <IconChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                );
            })}
        </div>
    );
}
