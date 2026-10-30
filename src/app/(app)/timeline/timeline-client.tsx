"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
    IconCalendar,
    IconChartLine,
    IconChevronDown,
    IconChevronRight,
    IconExternalLink,
    IconMinus,
    IconPlus,
    IconX,
} from "@tabler/icons-react";
import { PageHeader } from "@/components/page-header";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCost, type RunOutcome } from "@/lib/task-story";
import { formatRunDuration, formatTokenCount } from "@/lib/run-ledger-copy";
import { useLivePoll, type LivePollRun } from "@/lib/use-realtime";
import { cn } from "@/lib/utils";
import { useIsDarkTheme } from "@/lib/use-is-dark-theme";
import {
    autoFitTodayRange,
    clusterSpans,
    formatHours,
    groupTimelineByProject,
    joinAgentNames,
    projectHue,
    summarizeTimeSpent,
    timeTicks,
    type TimeSpent,
    type TimeSpentProject,
    type TimelineActor,
    type TimelineCluster,
    type TimelineEdge,
    type TimelineEvent,
    type TimelineEventKind,
    type TimelineProjectRow,
    type TimelineRowItem,
    type TimelineSource,
    type TimelineSpan,
    type WorkTimeline,
} from "@/lib/work-timeline";

const DAY_MS = 86_400_000;
const ROW_H = 44;
const LABEL_W = 208;
const AXIS_H = 30;
const BAR_H = 10;
/** Every pill and cluster gets an invisible hit target at least this wide, centred on it. */
const HIT_MIN_W = 10;
/** The hit target fills the row height minus this much at the top and bottom. */
const HIT_INSET_Y = 4;
/** Zoom is a magnification over "fill the container": 1 = fill, higher = zoom in (and scroll). */
const ZOOM_LEVELS = [1, 1.5, 2, 3, 4, 6];
const DEFAULT_ZOOM = 0;
const LIVE_TOPICS = ["agents", "projects"] as const;

type FilterOption = { value: string; label: string; description?: string | null };
type ColourBy = "outcome" | "source" | "project";
/** How a bar is filled: a colour-by mode, or (Projects view) the agent's own colour. */
type PillMode = ColourBy | "agent";
type RowsMode = "agents" | "projects";

/** One chart row: an agent (Agents view), or a project / the chat row (Projects view). */
interface ChartRow {
    id: string;
    kind: "agent" | "project" | "chat";
    label: string;
    sub: string;
    spans: TimelineSpan[];
    events: TimelineEvent[];
    actor?: TimelineActor;
    /** Projects view: who worked on it, busiest first. */
    actorIds?: string[];
}

/** Chat runs (no task) recede so task work stands out. */
const CHAT_MUTED = "opacity-30 hover:opacity-80";
const CHAT_PILL = { fill: "rgba(113,113,122,0.55)", stroke: "rgba(161,161,170,0.7)" };
type Focus =
    | { type: "task"; taskId: string }
    | { type: "agent"; actorId: string }
    | { type: "span"; spanId: string };

const OUTCOME_PILL: Record<RunOutcome, string> = {
    running: "#22d3ee",
    done: "#10b981",
    needs_you: "#f59e0b",
    failed: "#f43f5e",
    stopped: "#71717a",
};
const OUTCOME_STROKE: Record<RunOutcome, string> = {
    running: "#22d3ee",
    done: "#34d399",
    needs_you: "#fbbf24",
    failed: "#fb7185",
    stopped: "#71717a",
};
const SOURCE_PILL: Record<TimelineSource, { fill: string; stroke: string }> = {
    delegated: { fill: "#3b82f6", stroke: "#60a5fa" },
    automation: { fill: "#f59e0b", stroke: "#fbbf24" },
};


/** SVG colours per theme: attributes can't follow the CSS variables. */
const CHART_COLOURS = {
    dark: {
        event: {
            created: "#22d3ee",
            assigned: "#a78bfa",
            status: "#94a3b8",
            note: "#e2e8f0",
            approval_requested: "#fbbf24",
            approval_decided: "#34d399",
            file: "#38bdf8",
        } satisfies Record<TimelineEventKind, string>,
        clusterCount: "#e4e4e7",
        gridLine: "rgba(255,255,255,0.04)",
    },
    light: {
        event: {
            created: "#0891b2",
            assigned: "#7c3aed",
            status: "#64748b",
            note: "#334155",
            approval_requested: "#d97706",
            approval_decided: "#059669",
            file: "#0284c7",
        } satisfies Record<TimelineEventKind, string>,
        clusterCount: "#18181b",
        gridLine: "rgba(0,0,0,0.06)",
    },
};

/** The running-bar shimmer (CSS, not copy). */
const SHIMMER_CSS = `
                @media (prefers-reduced-motion: no-preference) {
                    @keyframes tl-shimmer {
                        0%, 100% { fill-opacity: 0.55; }
                        50% { fill-opacity: 0.95; }
                    }
                    .tl-running { animation: tl-shimmer 2.6s ease-in-out infinite; }
                }
            `;

function useChartColours() {
    return CHART_COLOURS[useIsDarkTheme() ? "dark" : "light"];
}

function formatBusy(ms: number): string {
    if (ms <= 0) return "0m";
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatPercent(rate: number | null | undefined): string {
    if (rate == null || !Number.isFinite(rate)) return "—";
    return `${Math.round(rate * 100)}%`;
}

/** Range bounds ("Oct 29") and clock times ("14:05"), in the viewer's language. */
function useTimelineFormat() {
    const format = useFormatter();
    return useMemo(() => ({
        range: (ms: number) => format.dateTime(new Date(ms), { month: "short", day: "numeric" }),
        clock: (ms: number) => format.dateTime(new Date(ms), { hour: "numeric", minute: "2-digit", hour12: false }),
    }), [format]);
}

// ─── Range presets ──────────────────────────────────────────────────────────

type Preset = "today" | "7d" | "30d" | "custom";

function localDayMs(value: string): number | null {
    const d = new Date(`${value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function matchesFocus(span: TimelineSpan, focus: Focus | null): boolean {
    if (!focus) return true;
    if (focus.type === "task") return span.taskId === focus.taskId;
    if (focus.type === "agent") return span.actorId === focus.actorId;
    return span.id === focus.spanId;
}

function clusterMatchesFocus(cluster: TimelineCluster, spanById: Map<string, TimelineSpan>, focus: Focus | null): boolean {
    if (!focus) return true;
    return cluster.spanIds.some((id) => {
        const span = spanById.get(id);
        return span ? matchesFocus(span, focus) : false;
    });
}

// ─── Client ─────────────────────────────────────────────────────────────────

export function TimelineClient({ initial, initialFilter, agents, projects, customers }: {
    initial: WorkTimeline;
    initialFilter?: { agentId?: string; projectId?: string; customerId?: string };
    agents: FilterOption[];
    projects: FilterOption[];
    customers: FilterOption[];
}) {
    const [range, setRange] = useState<{ preset: Preset; fromMs: number; toMs: number }>(() => {
        const auto = autoFitTodayRange(initial.spans, initial.now);
        return { preset: "today", fromMs: auto.fromMs, toMs: auto.toMs };
    });
    const [customFrom, setCustomFrom] = useState("");
    const [customTo, setCustomTo] = useState("");
    const [filters, setFilters] = useState<{ agentId: string; projectId: string; customerId: string }>({
        agentId: initialFilter?.agentId ?? "",
        projectId: initialFilter?.projectId ?? "",
        customerId: initialFilter?.customerId ?? "",
    });
    const [zoom, setZoom] = useState(DEFAULT_ZOOM);
    const [colourBy, setColourBy] = useState<ColourBy>("outcome");
    const [rowsMode, setRowsMode] = useState<RowsMode>("agents");
    const [showEvents, setShowEvents] = useState(false);
    const [data, setData] = useState<WorkTimeline>(initial);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [tooltip, setTooltip] = useState<{ x: number; y: number; node: React.ReactNode } | null>(null);
    const [focus, setFocus] = useState<Focus | null>(null);
    const [hoverActor, setHoverActor] = useState<string | null>(null);
    const [selected, setSelected] = useState<TimelineSpan | null>(null);
    const t = useTranslations("timeline");
    const tOutcomes = useTranslations("tasks.timeline.outcomes");
    const formatTime = useTimelineFormat();
    const loadFailed = t("loadFailed");

    const query = useMemo(() => {
        // Zoom and minimap drags produce fractional milliseconds; the API takes whole ones.
        const params = new URLSearchParams({ from: String(Math.floor(range.fromMs)), to: String(Math.ceil(range.toMs)) });
        if (filters.agentId) params.set("agentId", filters.agentId);
        if (filters.projectId) params.set("projectId", filters.projectId);
        if (filters.customerId) params.set("customerId", filters.customerId);
        return params.toString();
    }, [range.fromMs, range.toMs, filters.agentId, filters.projectId, filters.customerId]);

    const load = useCallback(async (run: LivePollRun) => {
        setLoading(true);
        try {
            const res = await fetch(`/api/timeline?${query}`, { cache: "no-store" });
            if (!res.ok) {
                const body = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(body.error || loadFailed);
            }
            const next = await res.json() as WorkTimeline;
            if (!run.active) return;
            setData(next);
            setError(null);
        } catch (err) {
            if (run.active && !(err instanceof DOMException && err.name === "AbortError")) {
                setError(err instanceof Error ? err.message : loadFailed);
            }
        } finally {
            if (run.active) setLoading(false);
        }
    }, [query, loadFailed]);

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
        setZoom(DEFAULT_ZOOM);
        if (preset === "today") {
            const auto = autoFitTodayRange(data.spans, Date.now());
            setRange({ preset: "today", fromMs: auto.fromMs, toMs: auto.toMs });
            return;
        }
        const now = Date.now();
        if (preset === "7d") setRange({ preset: "7d", fromMs: now - 7 * DAY_MS, toMs: now });
        else setRange({ preset: "30d", fromMs: now - 30 * DAY_MS, toMs: now });
    };

    const applyCustom = () => {
        const from = localDayMs(customFrom);
        const to = customTo ? localDayMs(customTo) : null;
        if (from == null) return;
        const toMs = to ? to + DAY_MS : Date.now();
        if (toMs <= from) return;
        setZoom(DEFAULT_ZOOM);
        setRange({ preset: "custom", fromMs: from, toMs });
    };

    const hasFilter = Boolean(filters.agentId || filters.projectId || filters.customerId);
    const clearFilters = () => setFilters({ agentId: "", projectId: "", customerId: "" });

    const actorById = useMemo(() => new Map(data.actors.map((a) => [a.id, a])), [data.actors]);
    const spanById = useMemo(() => new Map(data.spans.map((s) => [s.id, s])), [data.spans]);

    const openSpan = useCallback((span: TimelineSpan) => {
        setTooltip(null);
        setSelected(span);
        setFocus(span.taskId ? { type: "task", taskId: span.taskId } : { type: "span", spanId: span.id });
    }, []);

    const zoomToCluster = useCallback((cluster: TimelineCluster) => {
        const span = Math.max(cluster.end - cluster.start, 1);
        const margin = Math.max(span * 0.15, 5 * 60_000);
        setTooltip(null);
        setZoom(DEFAULT_ZOOM);
        setRange({ preset: "custom", fromMs: cluster.start - margin, toMs: cluster.end + margin });
    }, []);

    const changeRange = useCallback((fromMs: number, toMs: number) => {
        if (toMs <= fromMs) return;
        setTooltip(null);
        setZoom(DEFAULT_ZOOM);
        setRange({ preset: "custom", fromMs, toMs });
    }, []);

    const clear = useCallback(() => {
        setTooltip(null);
        setFocus(null);
        setSelected(null);
        setHoverActor(null);
    }, []);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") clear();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [clear]);

    const activeFocus: Focus | null = hoverActor ? { type: "agent", actorId: hoverActor } : focus;

    // Rows are agents only, so every span's actor is an agent.
    const agentsActive = useMemo(() => new Set(data.spans.map((s) => s.actorId)).size, [data.spans]);
    const projectRows = useMemo(() => groupTimelineByProject(data), [data]);
    const timeSpent = useMemo(() => summarizeTimeSpent(data), [data]);
    const pillMode: PillMode = rowsMode === "projects" ? "agent" : colourBy;
    const legendActors = useMemo(() => {
        const ids = new Set(data.spans.map((s) => s.actorId));
        return data.actors.filter((a) => ids.has(a.id));
    }, [data.actors, data.spans]);
    const taskTitleById = useMemo(() => {
        const map = new Map<string, string>();
        for (const s of data.spans) if (s.taskId && s.taskTitle) map.set(s.taskId, s.taskTitle);
        return map;
    }, [data.spans]);

    return (
        <div className="mx-auto w-full max-w-[1400px] space-y-5 pb-20">
            <PageHeader
                eyebrow={t("eyebrow")}
                title={t("title")}
                description={rowsMode === "agents" ? t("descriptionAgents") : t("descriptionProjects")}
            />

            {/* KPI row */}
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Total label={t("totals.runs")} value={String(data.totals.runs)} />
                <Total label={t("totals.agentsActive")} value={String(agentsActive)} />
                <Total label={t("totals.runTime")} value={formatBusy(data.totals.busyMs)} />
                <Total label={t("totals.tokens")} value={formatTokenCount(data.totals.tokens)} />
                <Total label={t("totals.cost")} value={formatCost(data.totals.costCents) ?? "$0.00"} />
                <Total label={t("totals.successRate")} value={formatPercent(data.totals.successRate)} />
            </dl>

            {/* One toolbar: range + colour-by + filters left, zoom right */}
            <div className="flex flex-wrap items-center gap-2">
                <div role="toolbar" aria-label={t("timeRange")} className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-950/40 p-1">
                    {(["today", "7d", "30d"] as Preset[]).map((preset) => (
                        <button key={preset} type="button" aria-pressed={range.preset === preset} onClick={() => setPreset(preset)}
                            className={cn("rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                                range.preset === preset ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200")}>
                            {preset === "today" ? t("presets.today") : preset === "7d" ? t("presets.7d") : t("presets.30d")}
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950/40 p-1.5">
                    <IconCalendar className="h-4 w-4 text-zinc-500" />
                    <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} aria-label={t("fromDate")} className="bg-transparent text-xs text-zinc-200 outline-none" />
                    <span className="text-zinc-600">–</span>
                    <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} aria-label={t("toDate")} className="bg-transparent text-xs text-zinc-200 outline-none" />
                    <button type="button" onClick={applyCustom} disabled={!customFrom} className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-100 disabled:opacity-50">{t("apply")}</button>
                </div>
                <span className="hidden text-xs text-zinc-500 xl:inline">{formatTime.range(range.fromMs)} – {formatTime.range(range.toMs)}</span>

                <div role="toolbar" aria-label={t("rows")} className="flex items-center gap-0.5 rounded-xl border border-zinc-800 bg-zinc-950/40 p-1">
                    <span className="px-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-600">{t("rows")}</span>
                    {(["agents", "projects"] as RowsMode[]).map((mode) => (
                        <button key={mode} type="button" aria-pressed={rowsMode === mode} onClick={() => { setRowsMode(mode); clear(); }}
                            className={cn("rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                                rowsMode === mode ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200")}>
                            {mode === "agents" ? t("rowsAgents") : t("rowsProjects")}
                        </button>
                    ))}
                </div>
                {rowsMode === "agents" && <div role="toolbar" aria-label={t("colourBy")} className="flex items-center gap-0.5 rounded-xl border border-zinc-800 bg-zinc-950/40 p-1">
                    {(["outcome", "source", "project"] as ColourBy[]).map((mode) => (
                        <button key={mode} type="button" aria-pressed={colourBy === mode} onClick={() => setColourBy(mode)}
                            className={cn("rounded-lg px-2.5 py-1.5 text-xs font-medium capitalize transition-colors",
                                colourBy === mode ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200")}>
                            {t(`colourModes.${mode}`)}
                        </button>
                    ))}
                </div>}
                <button type="button" aria-pressed={showEvents} onClick={() => setShowEvents((v) => !v)}
                    className={cn("rounded-xl border px-3 py-2 text-xs font-medium transition-colors",
                        showEvents ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-200" : "border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:text-zinc-200")}>
                    {t("showEvents")}
                </button>

                <div className="ml-auto flex items-center gap-1.5">
                    <div className="hidden flex-wrap items-center gap-1.5 lg:flex">
                        <SearchableSelect value={filters.agentId} onChange={(v) => setFilters((f) => ({ ...f, agentId: v }))}
                            options={[{ value: "", label: t("allAgents") }, ...agents]} placeholder={t("allAgents")} className="min-w-[150px]" />
                        <SearchableSelect value={filters.projectId} onChange={(v) => setFilters((f) => ({ ...f, projectId: v }))}
                            options={[{ value: "", label: t("allProjects") }, ...projects]} placeholder={t("allProjects")} className="min-w-[150px]" />
                        <SearchableSelect value={filters.customerId} onChange={(v) => setFilters((f) => ({ ...f, customerId: v }))}
                            options={[{ value: "", label: t("allCustomers") }, ...customers]} placeholder={t("allCustomers")} className="min-w-[150px]" />
                        {hasFilter && <button type="button" onClick={clearFilters} className="rounded-lg px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">{t("clear")}</button>}
                    </div>
                    <div className="flex items-center gap-0.5 rounded-xl border border-zinc-800 bg-zinc-950/40 p-1">
                        <button type="button" onClick={() => setZoom((z) => Math.max(0, z - 1))} disabled={zoom === 0} aria-label={t("zoomOut")} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"><IconMinus className="h-4 w-4" /></button>
                        <button type="button" onClick={() => setZoom(DEFAULT_ZOOM)} aria-label={t("resetZoom")} className="rounded-lg px-2 py-1.5 text-[11px] font-medium text-zinc-400 hover:text-zinc-200">{t("reset")}</button>
                        <button type="button" onClick={() => setZoom((z) => Math.min(ZOOM_LEVELS.length - 1, z + 1))} disabled={zoom === ZOOM_LEVELS.length - 1} aria-label={t("zoomIn")} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"><IconPlus className="h-4 w-4" /></button>
                    </div>
                </div>
            </div>

            {error && (
                <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p>
            )}
            {data.capped && (
                <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                    {t("capped")}
                </p>
            )}

            {/* Desktop: Gantt */}
            <div className={cn("hidden md:block", loading && "opacity-60 transition-opacity")}>
                <GanttChart
                    data={data}
                    fromMs={range.fromMs}
                    toMs={range.toMs}
                    zoom={zoom}
                    rowsMode={rowsMode}
                    projectRows={projectRows}
                    actorById={actorById}
                    pillMode={pillMode}
                    showEvents={showEvents}
                    focus={activeFocus}
                    spanById={spanById}
                    taskTitleById={taskTitleById}
                    onOpenSpan={openSpan}
                    onZoomCluster={zoomToCluster}
                    onRangeChange={changeRange}
                    onHoverActor={setHoverActor}
                    onClear={clear}
                    setTooltip={setTooltip}
                />
            </div>

            {/* Phone: per-actor list */}
            <div className="md:hidden">
                <PhoneList data={data} rowsMode={rowsMode} projectRows={projectRows} actorById={actorById} pillMode={pillMode} onOpen={openSpan} />
            </div>

            {/* Legend follows the colour mode */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-500">
                <span className="font-semibold uppercase tracking-wide text-zinc-600">{t("legend")}</span>
                {rowsMode === "projects" && legendActors.map((a) => (
                    <span key={a.id} className="inline-flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: a.colour }} />
                        {a.name}
                    </span>
                ))}
                {rowsMode === "projects" && (
                    <span className="inline-flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CHAT_PILL.fill }} />
                        {t("chatNoTask")}
                    </span>
                )}
                {rowsMode === "agents" && colourBy === "outcome" && (["done", "needs_you", "failed", "stopped", "running"] as RunOutcome[]).map((o) => (
                    <span key={o} className="inline-flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: OUTCOME_PILL[o] }} />
                        {tOutcomes(o)}
                    </span>
                ))}
                {rowsMode === "agents" && colourBy === "source" && (["delegated", "automation"] as TimelineSource[]).map((s) => (
                    <span key={s} className="inline-flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: SOURCE_PILL[s].fill }} />
                        {t(`sources.${s}`)}
                    </span>
                ))}
                {rowsMode === "agents" && colourBy === "project" && <span>{t("legendProjects")}</span>}
                {rowsMode === "agents" && <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm opacity-40" style={{ backgroundColor: CHAT_PILL.fill }} />{t("legendFaded")}</span>}
                <span className="ml-auto hidden items-center gap-1.5 lg:inline-flex"><kbd className="rounded border border-zinc-700 px-1 font-mono text-[10px]">Enter</kbd> {t("opensRun")} · <kbd className="rounded border border-zinc-700 px-1 font-mono text-[10px]">Esc</kbd> {t("clears")}</span>
            </div>

            <TimeSpentPanel summary={timeSpent} />

            {/* Detail panel */}
            {selected && (
                <>
                    <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={clear} />
                    <DetailPanel span={selected} actor={actorById.get(selected.actorId)} onClose={clear} />
                </>
            )}

            {/* The detail panel replaces the hover tooltip; never show both. */}
            {tooltip && !selected && (
                <div className="pointer-events-none fixed z-[60] max-w-xs rounded-xl border border-zinc-700 bg-zinc-950/95 px-3 py-2 shadow-2xl"
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

function GanttChart({ data, fromMs, toMs, zoom, rowsMode, projectRows, actorById, pillMode, showEvents, focus, spanById, taskTitleById, onOpenSpan, onZoomCluster, onRangeChange, onHoverActor, onClear, setTooltip }: {
    data: WorkTimeline;
    fromMs: number;
    toMs: number;
    zoom: number;
    rowsMode: RowsMode;
    projectRows: TimelineProjectRow[];
    actorById: Map<string, TimelineActor>;
    pillMode: PillMode;
    showEvents: boolean;
    focus: Focus | null;
    spanById: Map<string, TimelineSpan>;
    taskTitleById: Map<string, string>;
    onOpenSpan: (span: TimelineSpan) => void;
    onZoomCluster: (cluster: TimelineCluster) => void;
    onRangeChange: (fromMs: number, toMs: number) => void;
    onHoverActor: (actorId: string | null) => void;
    onClear: () => void;
    setTooltip: (t: { x: number; y: number; node: React.ReactNode } | null) => void;
}) {
    const colours = useChartColours();
    const t = useTranslations("timeline");
    const rootRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    const [idleOpen, setIdleOpen] = useState(false);
    const [scrollLeft, setScrollLeft] = useState(0);
    const [viewport, setViewport] = useState(0);

    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const measure = () => setContainerWidth(Math.max(0, el.clientWidth));
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const spansByActor = useMemo(() => {
        const map = new Map<string, TimelineSpan[]>();
        for (const s of data.spans) {
            const list = map.get(s.actorId);
            if (list) list.push(s);
            else map.set(s.actorId, [s]);
        }
        return map;
    }, [data.spans]);
    const eventsByActor = useMemo(() => {
        const map = new Map<string, TimelineEvent[]>();
        for (const e of data.events) {
            const list = map.get(e.actorId);
            if (list) list.push(e);
            else map.set(e.actorId, [e]);
        }
        return map;
    }, [data.events]);

    const windowMs = toMs - fromMs;
    const plotWidth = Math.max(120, containerWidth - LABEL_W);
    const zoomFactor = ZOOM_LEVELS[zoom] ?? 1;
    const chartWidth = Math.max(plotWidth, Math.round(plotWidth * zoomFactor));
    const pxPerMs = chartWidth / windowMs;
    const xFor = (ms: number) => (ms - fromMs) * pxPerMs;

    const { active, idle } = useMemo(() => {
        const active = data.actors.filter((a) => (spansByActor.get(a.id)?.length ?? 0) > 0 || (eventsByActor.get(a.id)?.length ?? 0) > 0);
        const idle = data.actors.filter((a) => (spansByActor.get(a.id)?.length ?? 0) === 0 && (eventsByActor.get(a.id)?.length ?? 0) === 0);
        return { active, idle };
    }, [data.actors, spansByActor, eventsByActor]);

    const rows: ChartRow[] = useMemo(() => {
        if (rowsMode === "projects") {
            return projectRows.map((r) => ({
                id: r.id,
                kind: r.kind,
                label: r.name,
                sub: [r.customerName, t("runCount", { count: r.runCount }), formatHours(r.busyMs)].filter(Boolean).join(" · "),
                spans: r.spans,
                events: r.events,
                actorIds: r.actorIds,
            }));
        }
        return (idleOpen ? [...active, ...idle] : active).map((a) => ({
            id: a.id,
            kind: "agent" as const,
            label: a.name,
            sub: t("agentSub", { runs: a.runCount, busy: Math.round((a.busyMs / Math.max(1, windowMs)) * 100) }),
            spans: spansByActor.get(a.id) ?? [],
            events: eventsByActor.get(a.id) ?? [],
            actor: a,
        }));
    }, [rowsMode, projectRows, active, idle, idleOpen, spansByActor, eventsByActor, windowMs, t]);
    const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows]);

    const itemsByRow = useMemo(() => {
        const map = new Map<string, TimelineRowItem[]>();
        for (const row of rows) map.set(row.id, clusterSpans(row.spans, pxPerMs));
        return map;
    }, [rows, pxPerMs]);

    const visibleEdges = useMemo(() => {
        // Handoffs join agent rows; the Projects view has none.
        if (!focus || rowsMode !== "agents") return [];
        if (focus.type === "task") return data.edges.filter((e) => e.taskId === focus.taskId);
        if (focus.type === "agent") return data.edges.filter((e) => e.from === focus.actorId || e.to === focus.actorId);
        return [];
    }, [focus, data.edges, rowsMode]);

    const ticks = useMemo(() => timeTicks(fromMs, toMs, chartWidth), [fromMs, toMs, chartWidth]);
    const nowX = xFor(data.now);
    const totalWidth = LABEL_W + chartWidth;
    const contentHeight = rows.length * ROW_H;

    const updateScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        // The tooltip is fixed-positioned; once the chart moves under it, it points at nothing.
        setTooltip(null);
        setScrollLeft(el.scrollLeft);
        setViewport(Math.max(1, el.clientWidth - LABEL_W));
    }, [setTooltip]);

    useEffect(() => { updateScroll(); }, [chartWidth, rows.length, updateScroll]);
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollLeft = 0;
    }, [fromMs, toMs]);

    return (
        <div ref={rootRef} className="overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/40">
            <style>{SHIMMER_CSS}</style>
            {data.actors.length === 0 || (rowsMode === "projects" && rows.length === 0) ? (
                <EmptyState
                    bordered={false}
                    icon={IconChartLine}
                    title={t("emptyTitle")}
                    description={t("emptyDescription")}
                />
            ) : (
                <>
                    <div ref={scrollRef} onScroll={updateScroll} className="timeline-scroll max-h-[62vh] overflow-auto overscroll-x-contain">
                        <div className="relative" style={{ width: totalWidth }}>
                            {/* Axis header */}
                            <div className="sticky top-0 z-30 flex" style={{ height: AXIS_H }}>
                                <div className="sticky left-0 z-40 shrink-0 border-b border-r border-zinc-800 bg-zinc-950" style={{ width: LABEL_W }} />
                                <div className="relative shrink-0 border-b border-zinc-800 bg-zinc-950/95" style={{ width: chartWidth }}>
                                    <svg width={chartWidth} height={AXIS_H} className="absolute inset-0 block" aria-hidden>
                                        {ticks.minor.map((t) => (
                                            <line key={t} x1={xFor(t)} x2={xFor(t)} y1={AXIS_H - 4} y2={AXIS_H} stroke="rgba(113,113,122,0.35)" strokeWidth={1} />
                                        ))}
                                        {ticks.major.map((t) => (
                                            <line key={t.ms} x1={xFor(t.ms)} x2={xFor(t.ms)} y1={AXIS_H - 7} y2={AXIS_H} stroke="rgba(161,161,170,0.6)" strokeWidth={1} />
                                        ))}
                                    </svg>
                                    {ticks.major.map((t) => (
                                        <span key={t.ms} className="absolute top-0 flex items-center whitespace-nowrap font-mono text-[10px] text-zinc-500" style={{ left: xFor(t.ms), height: AXIS_H - 7, transform: xFor(t.ms) < 32 ? "none" : xFor(t.ms) > chartWidth - 32 ? "translateX(-100%)" : "translateX(-50%)" }}>
                                            {t.label}
                                        </span>
                                    ))}
                                </div>
                            </div>

                            {/* Rows */}
                            {rows.map((row) => (
                                <div key={row.id} className="group/row flex" style={{ height: ROW_H }}>
                                    <div
                                        className="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-b border-r border-zinc-800/80 bg-zinc-950 px-3 transition-colors group-hover/row:bg-zinc-900/60"
                                        style={{ width: LABEL_W }}
                                        onMouseEnter={row.actor ? () => onHoverActor(row.id) : undefined}
                                        onMouseLeave={row.actor ? () => onHoverActor(null) : undefined}
                                        title={row.actor ? undefined : row.label}
                                    >
                                        {row.actor ? <ActorAvatar actor={row.actor} /> : <ProjectMark row={row} actorById={actorById} />}
                                        <div className="min-w-0 flex-1">
                                            <div className={cn("truncate text-sm font-medium", row.kind === "chat" ? "text-zinc-500" : "text-zinc-100")}>{row.label}</div>
                                            <div className="truncate text-[11px] text-zinc-500">{row.sub}</div>
                                        </div>
                                    </div>
                                    <div className={cn("relative shrink-0 border-b border-zinc-800/50 transition-colors group-hover/row:bg-zinc-900/30", row.kind === "chat" && "bg-zinc-900/20")} style={{ width: chartWidth }}>
                                        <svg width={chartWidth} height={ROW_H} className="block" role="presentation" onClick={onClear}>
                                            <RowContent
                                                actorById={actorById}
                                                items={itemsByRow.get(row.id) ?? []}
                                                events={showEvents ? row.events : []}
                                                xFor={xFor}
                                                pillMode={pillMode}
                                                focus={focus}
                                                spanById={spanById}
                                                taskTitleById={taskTitleById}
                                                onOpenSpan={onOpenSpan}
                                                onZoomCluster={onZoomCluster}
                                                setTooltip={setTooltip}
                                            />
                                        </svg>
                                    </div>
                                </div>
                            ))}

                            {/* Collapsed idle agents */}
                            {rowsMode === "agents" && idle.length > 0 && (
                                <div className="flex" style={{ height: ROW_H }}>
                                    <button
                                        type="button"
                                        onClick={() => setIdleOpen((v) => !v)}
                                        className="sticky left-0 z-20 flex w-full items-center gap-2 border-b border-r border-zinc-800/80 bg-zinc-950 px-3 text-left text-xs text-zinc-500 hover:bg-zinc-900/60"
                                        style={{ width: totalWidth }}
                                    >
                                        <IconChevronDown className={cn("h-4 w-4 transition-transform", idleOpen && "rotate-180")} />
                                        {idleOpen ? t("hideIdle") : t("showIdle", { count: idle.length })}
                                    </button>
                                </div>
                            )}

                            {/* Overlay: edges + now line */}
                            <div className="pointer-events-none absolute" style={{ left: LABEL_W, top: AXIS_H, width: chartWidth, height: contentHeight }}>
                                <svg width={chartWidth} height={contentHeight} className="block">
                                    {ticks.major.map((t) => (
                                        <line key={t.ms} x1={xFor(t.ms)} x2={xFor(t.ms)} y1={0} y2={contentHeight} stroke={colours.gridLine} strokeWidth={1} />
                                    ))}
                                    {data.now >= fromMs && data.now <= toMs && (
                                        <g>
                                            <line x1={nowX} x2={nowX} y1={0} y2={contentHeight} stroke="rgba(34,211,238,0.55)" strokeDasharray="3 3" strokeWidth={1} />
                                            <rect x={nowX - 16} y={0} width={32} height={14} rx={7} fill="rgba(34,211,238,0.9)" />
                                            <text x={nowX} y={10} textAnchor="middle" fontSize={9} fill="#04252b" fontWeight={600}>{t("now")}</text>
                                        </g>
                                    )}
                                    {visibleEdges.map((edge) => (
                                        <EdgePath key={edge.id} edge={edge} rowIndex={rowIndex} xFor={xFor} />
                                    ))}
                                </svg>
                            </div>
                        </div>
                    </div>

                    {/* Mini-map with drag handles */}
                    <Minimap
                        data={data}
                        fromMs={fromMs}
                        toMs={toMs}
                        plotWidth={plotWidth}
                        chartWidth={chartWidth}
                        scrollLeft={scrollLeft}
                        viewport={viewport}
                        onSeek={(left) => { const el = scrollRef.current; if (el) el.scrollLeft = left; }}
                        onRangeChange={onRangeChange}
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

/** A project row's mark: the colours of the agents that worked on it (up to three). */
function ProjectMark({ row, actorById }: { row: ChartRow; actorById: Map<string, TimelineActor> }) {
    const colours = (row.actorIds ?? []).slice(0, 3).map((id) => actorById.get(id)?.colour ?? CHAT_PILL.fill);
    return (
        <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg ring-1 ring-zinc-700", row.kind === "chat" ? "bg-zinc-900" : "bg-zinc-900/80")} aria-hidden>
            <span className="flex -space-x-1">
                {colours.map((c, i) => (
                    <span key={i} className={cn("h-2.5 w-2.5 rounded-full ring-1 ring-zinc-950", row.kind === "chat" && "opacity-40")} style={{ backgroundColor: c }} />
                ))}
            </span>
        </span>
    );
}

function pillStyle(span: TimelineSpan, colourBy: PillMode, actorById?: Map<string, TimelineActor>): { fill: string; stroke: string; hollow: boolean } {
    if (colourBy === "agent") {
        if (span.kind === "chat") return { ...CHAT_PILL, hollow: false };
        const colour = actorById?.get(span.actorId)?.colour;
        if (!colour) return { ...CHAT_PILL, hollow: false };
        return { fill: colour, stroke: colour, hollow: false };
    }
    if (colourBy === "source") {
        const c = SOURCE_PILL[span.source];
        return { fill: c.fill, stroke: c.stroke, hollow: false };
    }
    if (colourBy === "project") {
        if (!span.projectId) return { fill: "rgba(113,113,122,0.65)", stroke: "rgba(113,113,122,0.9)", hollow: false };
        const h = projectHue(span.projectId);
        return { fill: `hsl(${h} 72% 60%)`, stroke: `hsl(${h} 72% 65%)`, hollow: false };
    }
    if (span.outcome === "stopped") return { fill: "transparent", stroke: "#71717a", hollow: true };
    return { fill: OUTCOME_PILL[span.outcome], stroke: OUTCOME_STROKE[span.outcome], hollow: false };
}

/**
 * An invisible hit target around a drawn pill: at least HIT_MIN_W wide and
 * centred on it, nearly the full row tall. At 7 or 30 days a pill can be 2–4
 * px wide; the target keeps it easy to hover and click without changing the
 * pill itself.
 */
function HitRect({ x, width }: { x: number; width: number }) {
    const w = Math.max(HIT_MIN_W, width);
    return <rect x={x + width / 2 - w / 2} y={HIT_INSET_Y} width={w} height={ROW_H - 2 * HIT_INSET_Y} fill="transparent" pointerEvents="all" />;
}

function RowContent({ actorById, items, events, xFor, pillMode, focus, spanById, taskTitleById, onOpenSpan, onZoomCluster, setTooltip }: {
    actorById: Map<string, TimelineActor>;
    items: TimelineRowItem[];
    events: TimelineEvent[];
    xFor: (ms: number) => number;
    pillMode: PillMode;
    focus: Focus | null;
    spanById: Map<string, TimelineSpan>;
    taskTitleById: Map<string, string>;
    onOpenSpan: (span: TimelineSpan) => void;
    onZoomCluster: (cluster: TimelineCluster) => void;
    setTooltip: (t: { x: number; y: number; node: React.ReactNode } | null) => void;
}) {
    const colours = useChartColours();
    const t = useTranslations("timeline");
    const tOutcomes = useTranslations("tasks.timeline.outcomes");
    const y = (ROW_H - BAR_H) / 2;
    const showTooltip = (e: { currentTarget: Element }, node: React.ReactNode) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setTooltip({ x: rect.left + rect.width / 2, y: rect.top, node });
    };
    return (
        <>
            {items.map((item) => {
                if (item.kind === "cluster") {
                    const c = item.cluster;
                    const x = xFor(c.start);
                    const width = Math.max(4, xFor(c.end) - xFor(c.start));
                    const look = clusterLook(c, spanById, pillMode, actorById);
                    const dimmed = focus && !clusterMatchesFocus(c, spanById, focus) ? "opacity-20" : look.allChat ? CHAT_MUTED : "opacity-70 hover:opacity-100";
                    const cx = x + width / 2;
                    const mostly = pillMode === "agent"
                        ? (look.span ? actorById.get(look.span.actorId)?.name ?? t("agent") : t("chat"))
                        : tOutcomes(dominantOutcome(c));
                    return (
                        <g key={`c:${c.spanIds[0]}`}
                            role="button"
                            tabIndex={0}
                            className={cn("cursor-zoom-in transition-opacity", dimmed)}
                            onClick={(e) => { e.stopPropagation(); onZoomCluster(c); }}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onZoomCluster(c); } }}
                            onMouseEnter={(e) => showTooltip(e, <span className="text-xs text-zinc-200">{t("clusterTooltip", { count: c.count, mostly })}</span>)}
                            onMouseLeave={() => setTooltip(null)}
                            aria-label={t("clusterLabel", { count: c.count })}
                        >
                            <HitRect x={x} width={width} />
                            <rect x={x} y={y} width={width} height={BAR_H} rx={Math.min(BAR_H / 2, width / 2)} fill={look.style.fill} stroke={look.style.stroke} strokeWidth={1} />
                            {width >= 26 && <text x={cx} y={y + BAR_H / 2 + 3} textAnchor="middle" fontSize={8} fill={colours.clusterCount} fontWeight={600}>{c.count}</text>}
                        </g>
                    );
                }
                const span = item.span;
                const x = xFor(span.start);
                const width = Math.max(4, xFor(span.end) - xFor(span.start));
                const style = pillStyle(span, pillMode, actorById);
                const actorName = actorById.get(span.actorId)?.name ?? t("agent");
                // Chat runs recede (Agents view, and the greyed chat row) so task work stands out.
                const dimmed = !matchesFocus(span, focus)
                    ? "opacity-20"
                    : span.kind === "chat"
                        ? CHAT_MUTED
                        : span.outcome === "running" && pillMode === "outcome" ? "tl-running" : "opacity-70 hover:opacity-100";
                const rect = (
                    <>
                        <HitRect x={x} width={width} />
                        <rect x={x} y={y} width={width} height={BAR_H} rx={Math.min(BAR_H / 2, width / 2)}
                            fill={style.fill} stroke={style.stroke} strokeWidth={1}
                        />
                    </>
                );
                const what = span.kind === "chat" ? (span.threadLabel ? t("chatIn", { thread: span.threadLabel }) : t("chat")) : (span.taskTitle ?? t("task"));
                const label = t("spanLabel", { what, outcome: tOutcomes(span.outcome) });
                const handlers = {
                    onClick: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onOpenSpan(span); },
                    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onOpenSpan(span); } },
                    onMouseEnter: (e: React.MouseEvent) => showTooltip(e, <SpanTooltip span={span} actorName={actorName} />),
                    onMouseLeave: () => setTooltip(null),
                    onFocus: (e: React.FocusEvent) => showTooltip(e, <SpanTooltip span={span} actorName={actorName} />),
                    onBlur: () => setTooltip(null),
                };
                return span.href ? (
                    <a key={span.id} href={span.href} tabIndex={0} aria-label={label}
                        className={cn("transition-opacity", dimmed)} {...handlers}>
                        {rect}
                    </a>
                ) : (
                    <g key={span.id} role="button" tabIndex={0} aria-label={label}
                        className={cn("transition-opacity", dimmed)} {...handlers}>
                        {rect}
                    </g>
                );
            })}
            {events.map((ev) => (
                <EventTick key={ev.id} event={ev} cx={xFor(ev.at)} taskTitle={taskTitleById.get(ev.taskId) ?? null}
                    onEnter={(e) => showTooltip(e, <EventTooltip event={ev} taskTitle={taskTitleById.get(ev.taskId) ?? null} />)}
                    onLeave={() => setTooltip(null)} />
            ))}
        </>
    );
}

/**
 * A cluster takes the colour most of its runs share in the current colour
 * mode (task work wins over chat when both are folded in), so a cluster reads
 * like the runs inside it instead of a grey block.
 */
function clusterLook(cluster: TimelineCluster, spanById: Map<string, TimelineSpan>, pillMode: PillMode, actorById: Map<string, TimelineActor>): { style: { fill: string; stroke: string }; span: TimelineSpan | null; allChat: boolean } {
    const spans = cluster.spanIds.map((id) => spanById.get(id)).filter((s): s is TimelineSpan => Boolean(s));
    const work = spans.filter((s) => s.kind !== "chat");
    const pool = work.length > 0 ? work : spans;
    const tally = new Map<string, { n: number; span: TimelineSpan; style: { fill: string; stroke: string } }>();
    for (const span of pool) {
        const style = pillStyle(span, pillMode, actorById);
        const entry = tally.get(style.fill);
        if (entry) entry.n += 1;
        else tally.set(style.fill, { n: 1, span, style: { fill: style.fill, stroke: style.stroke } });
    }
    let best: { n: number; span: TimelineSpan; style: { fill: string; stroke: string } } | null = null;
    for (const entry of tally.values()) if (!best || entry.n > best.n) best = entry;
    return {
        style: best?.style ?? { fill: "rgba(148,163,184,0.4)", stroke: "rgba(148,163,184,0.7)" },
        span: work.length > 0 ? best?.span ?? null : null,
        allChat: spans.length > 0 && work.length === 0,
    };
}

function dominantOutcome(cluster: TimelineCluster): RunOutcome {
    let best: RunOutcome = "done";
    let bestN = -1;
    for (const [outcome, n] of Object.entries(cluster.outcomeCounts) as [RunOutcome, number][]) {
        if (n > bestN) { best = outcome; bestN = n; }
    }
    return best;
}

/** A marker's label in the viewer's language (lib/work-timeline.ts eventLabel, translated). */
function useEventLabel() {
    const t = useTranslations("timeline.events");
    return (event: TimelineEvent): string => {
        const name = event.byName?.trim();
        if (!name) return t(`kinds.${event.kind}`);
        if (event.kind !== "approval_decided") return t(`by.${event.kind}`, { name });
        const decision = event.decision === "approved" || event.decision === "rejected" || event.decision === "dismissed" ? event.decision : "other";
        return t(`decidedBy.${decision}`, { name });
    };
}

function EventTick({ event, cx, taskTitle, onEnter, onLeave }: {
    event: TimelineEvent;
    cx: number;
    taskTitle: string | null;
    onEnter: (e: React.MouseEvent) => void;
    onLeave: () => void;
}) {
    const colours = useChartColours();
    const label = useEventLabel()(event);
    // A person's action is drawn a little taller so it reads apart from the agent's own markers.
    const top = event.byName ? ROW_H - 12 : ROW_H - 9;
    return (
        <g onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={(e) => e.stopPropagation()} aria-label={taskTitle ? `${label}: ${taskTitle}` : label}>
            <rect x={cx - HIT_MIN_W / 2} y={ROW_H - 14} width={HIT_MIN_W} height={13} fill="transparent" pointerEvents="all" />
            <line x1={cx} x2={cx} y1={top} y2={ROW_H - 3} stroke={colours.event[event.kind]} strokeWidth={1.5} />
        </g>
    );
}

function EventTooltip({ event, taskTitle }: { event: TimelineEvent; taskTitle: string | null }) {
    const formatTime = useTimelineFormat();
    const label = useEventLabel()(event);
    return (
        <div className="space-y-0.5">
            <div className="text-sm font-medium text-zinc-100">{label}</div>
            {taskTitle && <div className="text-xs text-zinc-400">{taskTitle}</div>}
            <div className="text-xs text-zinc-500">{formatTime.clock(event.at)}</div>
        </div>
    );
}

function EdgePath({ edge, rowIndex, xFor }: { edge: TimelineEdge; rowIndex: Map<string, number>; xFor: (ms: number) => number }) {
    const t = useTranslations("timeline.edges");
    const from = rowIndex.get(edge.from);
    const to = rowIndex.get(edge.to);
    if (from == null || to == null) return null;
    const x = xFor(edge.at);
    const y1 = from * ROW_H + ROW_H / 2;
    const y2 = to * ROW_H + ROW_H / 2;
    const dy = y2 - y1;
    const bulge = Math.min(48, Math.max(24, Math.abs(dy) * 0.35));
    const d = `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x} ${y2}`;
    return (
        <g>
            <path d={d} fill="none" stroke="rgba(148,163,184,0.9)" strokeWidth={1.25} strokeOpacity={0.7} />
            <path d={`M ${x - 3.5} ${y2 + (dy >= 0 ? -5 : 5)} L ${x} ${y2} L ${x + 3.5} ${y2 + (dy >= 0 ? -5 : 5)}`} fill="none" stroke="rgba(148,163,184,0.9)" strokeWidth={1.25} />
            <title>{t(edge.kind)}</title>
        </g>
    );
}

function Minimap({ data, fromMs, toMs, plotWidth, chartWidth, scrollLeft, viewport, onSeek, onRangeChange }: {
    data: WorkTimeline;
    fromMs: number;
    toMs: number;
    plotWidth: number;
    chartWidth: number;
    scrollLeft: number;
    viewport: number;
    onSeek: (left: number) => void;
    onRangeChange: (fromMs: number, toMs: number) => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const height = 40;
    const labelGap = LABEL_W;
    const windowMs = toMs - fromMs;
    const xMini = (ms: number) => ((ms - fromMs) / windowMs) * plotWidth;
    const [drag, setDrag] = useState<null | { mode: "body" | "left" | "right"; startX: number; startFrom: number; startTo: number; startScrollLeft: number }>(null);
    const [preview, setPreview] = useState<{ from: number; to: number } | null>(null);

    const clientToMs = (clientX: number) => {
        const rect = ref.current!.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (clientX - rect.left - labelGap) / plotWidth));
        return fromMs + frac * windowMs;
    };

    const onPointerDown = (mode: "body" | "left" | "right") => (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDrag({ mode, startX: e.clientX, startFrom: fromMs, startTo: toMs, startScrollLeft: scrollLeft });
    };

    const onPointerMove = (e: React.PointerEvent) => {
        if (!drag) return;
        if (drag.mode === "body") {
            const dx = e.clientX - drag.startX;
            const next = drag.startScrollLeft + dx * (chartWidth / plotWidth);
            onSeek(Math.max(0, Math.min(chartWidth - viewport, next)));
            return;
        }
        const t = clientToMs(e.clientX);
        if (drag.mode === "left") {
            setPreview({ from: Math.min(t, drag.startTo - 5 * 60_000), to: drag.startTo });
        } else {
            setPreview({ from: drag.startFrom, to: Math.max(t, drag.startFrom + 5 * 60_000) });
        }
    };

    const onPointerUp = () => {
        if (drag?.mode === "left" && preview) onRangeChange(Math.max(fromMs - 31 * DAY_MS, preview.from), preview.to);
        else if (drag?.mode === "right" && preview) onRangeChange(preview.from, Math.min(Date.now() + 15 * 60_000, preview.to));
        setDrag(null);
        setPreview(null);
    };

    const brushFrom = preview ? preview.from : fromMs + (scrollLeft / chartWidth) * windowMs;
    const brushTo = preview ? preview.to : fromMs + ((scrollLeft + viewport) / chartWidth) * windowMs;

    return (
        <div ref={ref} className="relative hidden border-t border-zinc-800/80 bg-zinc-950/60 md:block"
            style={{ height: height + 8 }}
            onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <div className="absolute" style={{ left: labelGap, top: 4, width: plotWidth, height }}>
                <svg width={plotWidth} height={height}>
                    {data.spans.map((s) => {
                        const x = xMini(s.start);
                        const w = Math.max(1.5, xMini(s.end) - xMini(s.start));
                        return <rect key={s.id} x={x} y={12} width={w} height={height - 24} fill={OUTCOME_PILL[s.outcome]} opacity={0.5} />;
                    })}
                </svg>
            </div>
            {/* Brush with drag handles */}
            <div className="absolute top-0 rounded ring-1 ring-cyan-400/60 bg-cyan-400/10"
                style={{ left: labelGap + xMini(brushFrom), width: Math.max(24, xMini(brushTo) - xMini(brushFrom)), height: height + 8 }}>
                <div className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize" onPointerDown={onPointerDown("left")} aria-hidden />
                <div className="absolute inset-0 cursor-grab active:cursor-grabbing" onPointerDown={onPointerDown("body")} aria-hidden />
                <div className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize" onPointerDown={onPointerDown("right")} aria-hidden />
            </div>
        </div>
    );
}

// ─── Tooltip + phone list + detail panel ────────────────────────────────────

function SpanTooltip({ span, actorName }: { span: TimelineSpan; actorName: string }) {
    const t = useTranslations("timeline");
    const tOutcomes = useTranslations("tasks.timeline.outcomes");
    const formatTime = useTimelineFormat();
    const parts = [formatRunDuration(span.durationMs)];
    if (span.toolCalls != null) parts.push(t("toolCount", { count: span.toolCalls }));
    if (span.tokens > 0) parts.push(t("tokenCount", { tokens: formatTokenCount(span.tokens) }));
    const cost = formatCost(span.costCents);
    if (cost) parts.push(cost);
    return (
        <div className="space-y-0.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                {span.kind === "chat" && <><span>{t("chat")}</span><span>·</span></>}
                <span>{tOutcomes(span.outcome)}</span>
                <span>·</span>
                <span>{actorName}</span>
            </div>
            <div className="text-sm font-medium text-zinc-100">{span.taskTitle ?? (span.threadLabel ?? t("chat"))}</div>
            {span.projectName && <div className="text-xs text-zinc-400">{[span.projectName, span.customerName].filter(Boolean).join(" · ")}</div>}
            <div className="text-xs text-zinc-400">
                {formatTime.clock(span.startedAtMs)} – {span.endedAtMs ? formatTime.clock(span.endedAtMs) : t("now")}
            </div>
            <div className="text-xs tabular-nums text-zinc-500">{parts.filter(Boolean).join(" · ")}</div>
        </div>
    );
}

function DetailPanel({ span, actor, onClose }: { span: TimelineSpan; actor: TimelineActor | undefined; onClose: () => void }) {
    const t = useTranslations("timeline");
    const tOutcomes = useTranslations("tasks.timeline.outcomes");
    const formatTime = useTimelineFormat();
    const openLabel = span.kind === "chat" ? t("detail.openChat") : t("detail.openTask");
    return (
        <aside className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-zinc-800 bg-zinc-950 shadow-2xl md:inset-x-auto md:inset-y-0 md:right-0 md:max-h-none md:w-[360px] md:rounded-none md:border-l md:border-t-0">
            <div className="flex items-start justify-between gap-3 border-b border-zinc-800/80 px-5 py-4">
                <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{span.kind === "chat" ? t("detail.chatRun") : t("detail.taskRun")}</p>
                    <h2 className="mt-1 break-words text-sm font-semibold leading-snug text-zinc-100">{span.taskTitle ?? span.threadLabel ?? t("chat")}</h2>
                </div>
                <button type="button" onClick={onClose} aria-label={t("detail.close")} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"><IconX className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3 px-5 py-4 text-sm">
                <Field label={t("detail.agent")}>{actor ? actor.name : "—"}</Field>
                <Field label={t("detail.kind")}>{span.kind === "chat" ? t("chatNoTask") : t("task")}</Field>
                <Field label={t("detail.project")}>{span.projectName ?? "—"}</Field>
                {span.customerName && <Field label={t("detail.customer")}>{span.customerName}</Field>}
                <Field label={t("detail.outcome")}>
                    <span className="inline-flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: OUTCOME_PILL[span.outcome] }} />
                        {tOutcomes(span.outcome)}
                    </span>
                </Field>
                <Field label={t("detail.time")}>{formatTime.clock(span.startedAtMs)} – {span.endedAtMs ? formatTime.clock(span.endedAtMs) : t("now")}</Field>
                <Field label={t("detail.duration")}>{formatRunDuration(span.durationMs)}</Field>
                <Field label={t("detail.tools")}>{span.toolCalls ?? "—"}</Field>
                <Field label={t("totals.tokens")}>{span.tokens > 0 ? formatTokenCount(span.tokens) : "—"}</Field>
                <Field label={t("totals.cost")}>{formatCost(span.costCents) ?? "—"}</Field>
            </div>
            {span.href && (
                <div className="border-t border-zinc-800/80 px-5 py-4">
                    <Link href={span.href} className="inline-flex items-center gap-2 rounded-xl bg-cyan-500/15 px-3 py-2 text-sm font-medium text-cyan-200 ring-1 ring-inset ring-cyan-500/40 hover:bg-cyan-500/25">
                        {openLabel}<IconExternalLink className="h-4 w-4" />
                    </Link>
                </div>
            )}
        </aside>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-4">
            <span className="shrink-0 text-xs uppercase tracking-wide text-zinc-500">{label}</span>
            <span className="min-w-0 text-right font-mono text-sm tabular-nums text-zinc-100">{children}</span>
        </div>
    );
}

function PhoneList({ data, rowsMode, projectRows, actorById, pillMode, onOpen }: {
    data: WorkTimeline;
    rowsMode: RowsMode;
    projectRows: TimelineProjectRow[];
    actorById: Map<string, TimelineActor>;
    pillMode: PillMode;
    onOpen: (span: TimelineSpan) => void;
}) {
    const t = useTranslations("timeline");
    const tOutcomes = useTranslations("tasks.timeline.outcomes");
    const formatTime = useTimelineFormat();
    const sections = useMemo(() => {
        if (rowsMode === "projects") {
            return projectRows.map((r) => ({
                id: r.id,
                title: r.name,
                sub: t("runCount", { count: r.runCount }),
                lead: <ProjectMark row={{ id: r.id, kind: r.kind, label: r.name, sub: "", spans: r.spans, events: r.events, actorIds: r.actorIds }} actorById={actorById} />,
                muted: r.kind === "chat",
                spans: r.spans,
            }));
        }
        const byActor = new Map<string, TimelineSpan[]>();
        for (const s of data.spans) {
            const list = byActor.get(s.actorId);
            if (list) list.push(s);
            else byActor.set(s.actorId, [s]);
        }
        return data.actors.map((actor) => ({
            id: actor.id,
            title: actor.name,
            sub: t("runCount", { count: actor.runCount }),
            lead: <ActorAvatar actor={actor} />,
            muted: false,
            spans: byActor.get(actor.id) ?? [],
        }));
    }, [rowsMode, projectRows, actorById, data.spans, data.actors, t]);
    if (data.actors.length === 0 || sections.every((s) => s.spans.length === 0)) {
        return <EmptyState icon={IconChartLine} title={t("emptyTitle")} description={t("emptyDescription")} />;
    }
    return (
        <div className="space-y-5">
            {sections.map((section) => {
                const spans = section.spans.slice().sort((a, b) => b.start - a.start);
                if (spans.length === 0) return null;
                return (
                    <section key={section.id} aria-label={section.title}>
                        <header className="mb-2 flex items-center gap-2 px-1">
                            {section.lead}
                            <span className={cn("truncate text-sm font-semibold", section.muted ? "text-zinc-500" : "text-zinc-100")}>{section.title}</span>
                            <span className="ml-auto shrink-0 text-xs text-zinc-500">{section.sub}</span>
                        </header>
                        <ul className="space-y-2">
                            {spans.map((span) => {
                                const style = pillStyle(span, pillMode, actorById);
                                const chat = span.kind === "chat";
                                return (
                                    <li key={span.id}>
                                        <button type="button" onClick={() => onOpen(span)}
                                            className={cn("flex w-full items-center gap-3 rounded-xl border border-zinc-800/80 bg-zinc-950/40 px-3 py-2 text-left transition-colors hover:border-zinc-700", chat && "opacity-60")}>
                                            <span className="h-4 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: style.hollow ? style.stroke : style.fill, outline: style.hollow ? `1px solid ${style.stroke}` : undefined }} />
                                            <span className="min-w-0 flex-1">
                                                <span className={cn("block truncate text-sm", chat ? "text-zinc-400" : "text-zinc-100")}>{chat ? (span.threadLabel ? `${t("chat")} · ${span.threadLabel}` : t("chat")) : (span.taskTitle ?? t("task"))}</span>
                                                <span className="block truncate text-xs text-zinc-500">
                                                    {rowsMode === "projects" ? `${actorById.get(span.actorId)?.name ?? t("agent")} · ` : ""}
                                                    {formatTime.clock(span.startedAtMs)} – {span.endedAtMs ? formatTime.clock(span.endedAtMs) : t("now")} · {tOutcomes(span.outcome)}
                                                </span>
                                            </span>
                                            <IconChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                );
            })}
        </div>
    );
}

// ─── Where the time went ────────────────────────────────────────────────────

/** "3.2 h · $1.40 · Builder + QA" — the cost part only when there is one. */
function timeSpentMeta(item: { busyMs: number; costCents: number; agentNames: string[] }): string {
    const cost = item.costCents > 0 ? formatCost(item.costCents) : null;
    return [formatHours(item.busyMs), cost, item.agentNames.length > 0 ? joinAgentNames(item.agentNames) : null].filter(Boolean).join(" · ");
}

function TimeSpentPanel({ summary }: { summary: TimeSpent }) {
    const t = useTranslations("timeline.timeSpent");
    const tTimeline = useTranslations("timeline");
    const hasWork = summary.tasks.length > 0 || summary.chat.runs > 0;
    return (
        <section aria-labelledby="time-spent-title" className="rounded-2xl border border-zinc-800/80 bg-zinc-950/40">
            <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-800/80 px-5 py-3">
                <h2 id="time-spent-title" className="text-sm font-semibold text-zinc-100">{t("title")}</h2>
                <span className="text-xs text-zinc-500">{t("subtitle", { total: formatHours(summary.busyMs) })}</span>
            </header>
            {!hasWork ? (
                <p className="px-5 py-6 text-sm text-zinc-500">{t("noRuns")}</p>
            ) : (
                <div className="grid gap-6 px-5 py-4 lg:grid-cols-2">
                    <div className="min-w-0">
                        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{t("topTasks")}</h3>
                        {summary.tasks.length === 0 ? (
                            <p className="text-sm text-zinc-500">{t("noTaskWork")}</p>
                        ) : (
                            <ol className="space-y-1.5">
                                {summary.tasks.map((task) => (
                                    <li key={task.taskId} className="flex min-w-0 items-baseline gap-2 text-sm">
                                        <Link href={task.href} className="min-w-0 truncate font-medium text-zinc-100 hover:text-cyan-200 hover:underline">{task.title}</Link>
                                        <span className="shrink-0 truncate text-xs tabular-nums text-zinc-500">· {timeSpentMeta(task)}</span>
                                    </li>
                                ))}
                            </ol>
                        )}
                    </div>
                    <div className="min-w-0">
                        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{t("projects")}</h3>
                        <ul className="space-y-1">
                            {summary.projects.map((project) => <TimeSpentProjectRow key={project.projectId} project={project} />)}
                            {summary.chat.runs > 0 && (
                                <li className="flex min-w-0 items-baseline gap-2 py-1 pl-6 text-sm text-zinc-500">
                                    <span className="truncate">{tTimeline("chatNoTask")}</span>
                                    <span className="shrink-0 text-xs tabular-nums">
                                        · {[formatHours(summary.chat.busyMs), summary.chat.costCents > 0 ? formatCost(summary.chat.costCents) : null, tTimeline("runCount", { count: summary.chat.runs })].filter(Boolean).join(" · ")}
                                    </span>
                                </li>
                            )}
                        </ul>
                    </div>
                </div>
            )}
        </section>
    );
}

function TimeSpentProjectRow({ project }: { project: TimeSpentProject }) {
    const [open, setOpen] = useState(false);
    return (
        <li>
            <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
                className="flex w-full min-w-0 items-baseline gap-2 rounded-lg py-1 text-left text-sm hover:bg-zinc-900/50">
                <IconChevronRight className={cn("h-4 w-4 shrink-0 self-center text-zinc-600 transition-transform", open && "rotate-90")} />
                <span className="min-w-0 truncate font-medium text-zinc-100">
                    {project.name}
                    {project.customerName && <span className="font-normal text-zinc-500"> · {project.customerName}</span>}
                </span>
                <span className="shrink-0 truncate text-xs tabular-nums text-zinc-500">· {timeSpentMeta(project)}</span>
            </button>
            {open && (
                <ul className="mb-1 ml-6 space-y-1 border-l border-zinc-800 pl-3">
                    {project.tasks.map((task) => (
                        <li key={task.taskId} className="flex min-w-0 items-baseline gap-2 text-sm">
                            <Link href={task.href} className="min-w-0 truncate text-zinc-200 hover:text-cyan-200 hover:underline">{task.title}</Link>
                            <span className="shrink-0 truncate text-xs tabular-nums text-zinc-500">· {timeSpentMeta(task)}</span>
                        </li>
                    ))}
                </ul>
            )}
        </li>
    );
}
