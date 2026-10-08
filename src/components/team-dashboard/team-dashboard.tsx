"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { IconRadar, IconBox, IconDotsVertical, IconLayoutList, IconSearch, IconX, IconUsersGroup } from "@tabler/icons-react";
import {
    requiresHumanAction, filterDashboardBoard, snapshotFreshness, defaultSelection, deriveSceneAgents, kpiCounts, matchesKpi, matchesQuery, ZONES,
    type DashboardData, type KpiFilter, type SceneAgent, type ZoneId,
} from "@/lib/team-scene";
import { NotificationBell } from "@/components/notification-bell";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { TeamObservatory } from "./team-observatory";
import { TeamStructure } from "./team-structure";
import { TeamPulse } from "./team-pulse";
import { AgentList } from "./agent-list";
import { KpiRow } from "./kpi-row";
import { MetricsRow } from "./metrics-row";
import { MovementFeed } from "./movement-feed";
import { NeedsAttention } from "./needs-attention";
import { SelectedAgent } from "./selected-agent";
import { WorkBoard, type BoardAssignee } from "./work-board";

function subscribeReducedMotion(onChange: () => void) {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
}

function usePrefersReducedMotion(): boolean {
    return useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => false);
}

function subscribeClock(onChange: () => void) {
    const timer = window.setInterval(onChange, 10_000);
    window.addEventListener("online", onChange);
    window.addEventListener("offline", onChange);
    return () => { window.clearInterval(timer); window.removeEventListener("online", onChange); window.removeEventListener("offline", onChange); };
}
/** Container: owns filters and selection, derives everything else from server data. */
export function TeamDashboard({ data, initialView, canAct, isOwnerOrAdmin }: {
    data: DashboardData;
    initialView?: "scene" | "pulse" | "list" | "teams";
    hasAgents: boolean;
    canAct: boolean;
    isOwnerOrAdmin: boolean;
}) {
    const [chosenView, setChosenView] = useState<"scene" | "pulse" | "list" | "teams" | null>(null);
    const setView = (nextView: "scene" | "pulse" | "list" | "teams") => {
        setChosenView(nextView);
        const url = new URL(window.location.href);
        url.searchParams.set("view", nextView);
        window.history.replaceState(window.history.state, "", url);
    };
    const view = chosenView ?? initialView ?? "scene";
    const [motionPaused, setMotionPaused] = useState(false);
    const playfulIdle = false;
    const inboxRef = useRef<HTMLDivElement>(null);
    const detailRef = useRef<HTMLDivElement>(null);
    const [kpi, setKpi] = useState<KpiFilter | null>(null);
    const [query, setQuery] = useState("");
    const [zoneFilter, setZoneFilter] = useState<ZoneId | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const reducedMotion = usePrefersReducedMotion() || motionPaused;
    const searchRef = useRef<HTMLInputElement>(null);
    const clock = useSyncExternalStore(subscribeClock, () => Math.floor(Date.now() / 10_000) * 10_000, () => Date.parse(data.generatedAt));
    const now = useMemo(() => new Date(Math.max(clock, Date.parse(data.generatedAt))), [clock, data.generatedAt]);
    const online = useSyncExternalStore(subscribeClock, () => navigator.onLine, () => true);
    const freshness = snapshotFreshness(data.generatedAt, now, online);
    const actions = useMemo(() => data.attention.filter(requiresHumanAction), [data.attention]);
    const watchlist = useMemo(() => data.attention.filter((entry) => !requiresHumanAction(entry)), [data.attention]);
    const actionMembers = useMemo(() => new Set(actions.map((entry) => entry.memberKey)), [actions]);

    const observedData = useMemo(() => freshness === "current" ? data : { ...data, members: data.members.map((member) => ({ ...member, activity: null, runtimeOnline: false })) }, [data, freshness]);
    const agents = useMemo(() => deriveSceneAgents(observedData, playfulIdle, now), [observedData, playfulIdle, now]);
    const counts = useMemo(() => kpiCounts(agents, data), [agents, data]);
    const byKey = useMemo(() => new Map(agents.map((a) => [a.member.key, a])), [agents]);

    const isActive = useCallback((agent: SceneAgent) => (kpi === "attention" ? actionMembers.has(agent.member.key) : matchesKpi(kpi, agent.member, agent.status)) && matchesQuery(agent, query) && (!zoneFilter || agent.zone === zoneFilter), [kpi, query, zoneFilter, actionMembers]);

    // Keep a valid selection across refreshes; fall back to the busiest member.
    const selectedKey = selected && byKey.has(selected) ? selected : defaultSelection(agents);
    const selectedAgent = selectedKey ? byKey.get(selectedKey) ?? null : null;

    const assignees = useMemo(() => {
        const map = new Map<string, BoardAssignee>();
        for (const m of data.members) {
            const a = byKey.get(m.key);
            map.set(m.key, { member: m, zone: a?.zone === "lounge" || !a ? "operations" : a.zone });
        }
        return map;
    }, [data.members, byKey]);
    const columns = useMemo(() => filterDashboardBoard(data.board, { kpi, query, zoneFilter, members: data.members }), [data.board, data.members, kpi, query, zoneFilter]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                searchRef.current?.focus();
                searchRef.current?.select();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const shortcut = useSyncExternalStore(() => () => {}, () => (/mac|iphone|ipad/i.test(navigator.userAgent) ? "⌘K" : "Ctrl K"), () => "⌘K");

    const selectMember = (key: string) => {
        setSelected(key);
        if (window.innerWidth < 1280) detailRef.current?.scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "start" });
    };
    const focusMember = (key: string) => {
        selectMember(key);
        setKpi(null);
        setQuery("");
        setZoneFilter(null);
    };

    const toggleKpi = (id: KpiFilter) => {
        setKpi((current) => current === id ? null : id);
        setZoneFilter(null);
        if (id === "attention") inboxRef.current?.scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "start" });
    };

    // Throughput/cost KPI cards open the list view pre-filtered to their state.
    const openFiltered = (filter: KpiFilter) => {
        setKpi(filter);
        setZoneFilter(null);
        setView("list");
    };

    return (
        <div className="space-y-5">
            <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                    <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-[2.1rem]">Your team, in motion</h1>
                    <p className="mt-1 text-base text-muted-foreground">Real work. Recognizable agents. Clear decisions.</p>
                </div>
                <div className="flex items-center gap-2 lg:pt-1">
                    <label className="relative flex min-w-0 flex-1 items-center lg:w-[22rem] lg:flex-none">
                        <span className="sr-only">Search agents, tasks, or projects</span>
                        <IconSearch className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground" />
                        <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
                            placeholder="Search agents, tasks, or projects…" type="search"
                            className="h-10 w-full rounded-xl border border-border bg-card/70 pl-9 pr-16 text-sm text-foreground shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/25 dark:bg-zinc-950/60 [&::-webkit-search-cancel-button]:hidden" />
                        {query ? (
                            <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-2 grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><IconX className="h-3.5 w-3.5" /></button>
                        ) : (
                            <kbd className="pointer-events-none absolute right-2.5 rounded-md border border-border bg-muted px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted-foreground">{shortcut}</kbd>
                        )}
                    </label>
                    <NotificationBell collapsed variant="header" />
                </div>
            </header>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_21.5rem]">
                <div className="min-w-0 space-y-4">
                    <KpiRow counts={counts} active={kpi} onToggle={toggleKpi} />
                    <MetricsRow cost={data.cost} throughput={data.throughput} onFilter={openFiltered} />

                    {(kpi || query || zoneFilter) && <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm">
                        <span className="text-muted-foreground">{kpi === "attention" ? "Agents linked to the action inbox" : kpi === "done" ? "Agents that delivered in the last 24h" : kpi === "working" ? "Working agents and in-progress tasks" : kpi === "waiting" ? "Agents with work awaiting review" : "Filtered workspace"}{query && ` · “${query}”`}</span>
                        <button type="button" onClick={() => { setKpi(null); setQuery(""); setZoneFilter(null); }} className="min-h-11 rounded-lg px-3 font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-cyan-400">Clear filters</button>
                    </div>}
                    <section aria-labelledby="live-workspace-title" className="emperor-panel rounded-2xl p-3 sm:p-4">
                        <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-2.5">
                                <IconBox className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" stroke={1.8} />
                                <div className="min-w-0">
                                    <h2 id="live-workspace-title" className="flex items-center gap-2 text-base font-semibold text-foreground">
                                        Live workspace
                                        <span role="status" className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset", freshness === "current" ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300" : "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300")}>
                                            <span className={cn("h-1.5 w-1.5 rounded-full", freshness === "current" ? "bg-emerald-500" : "bg-amber-500")} />
                                            {freshness === "current" ? "Updated recently" : freshness === "offline" ? "Offline · saved snapshot" : "Updates delayed"}
                                        </span>
                                    </h2>
                                    <p className="text-xs text-muted-foreground">{`${agents.length} agents · refreshes every 15s · work and connection shown separately`}</p>
                                </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <div role="tablist" aria-label="Workspace view" className="flex rounded-xl border border-border bg-muted/40 p-0.5 dark:bg-white/[0.03]">
                                    {([["scene", "Scene", IconBox], ["pulse", "Pulse", IconRadar], ["list", "List", IconLayoutList], ["teams", "Teams", IconUsersGroup]] as const).map(([id, label, Icon]) => (
                                        <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
                                            className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-[10px] px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
                                                view === id ? "bg-cyan-500/15 text-cyan-700 ring-1 ring-inset ring-cyan-500/40 dark:text-cyan-200" : "text-muted-foreground hover:text-foreground")}>
                                            <Icon className="h-4 w-4" stroke={1.8} />{label}
                                        </button>
                                    ))}
                                </div>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <button type="button" aria-label="Workspace options" className="grid h-11 w-11 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"><IconDotsVertical className="h-4 w-4" /></button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-52">
                                        <DropdownMenuCheckboxItem checked={motionPaused} onCheckedChange={setMotionPaused}>Pause motion</DropdownMenuCheckboxItem>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem asChild><Link href="/agents">Manage agents</Link></DropdownMenuItem>
                                        <DropdownMenuItem asChild><Link href="/agents/health">Agent health</Link></DropdownMenuItem>
                                        <DropdownMenuItem asChild><Link href="/projects">Open projects board</Link></DropdownMenuItem>
                                        {(kpi || query || zoneFilter) && (
                                            <>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem onSelect={() => { setKpi(null); setQuery(""); setZoneFilter(null); }}>Clear filters</DropdownMenuItem>
                                            </>
                                        )}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                        </header>

                        {zoneFilter && (
                            <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                                Showing
                                <button type="button" onClick={() => setZoneFilter(null)} className="inline-flex items-center gap-1 rounded-md bg-cyan-500/10 px-2 py-0.5 font-medium text-cyan-700 ring-1 ring-inset ring-cyan-500/30 hover:bg-cyan-500/20 dark:text-cyan-200">
                                    {ZONES[zoneFilter].label}<IconX className="h-3 w-3" />
                                </button>
                            </div>
                        )}

                        {view === "scene" ? (
                            <TeamObservatory companyName={data.companyName ?? "Your company"} agents={agents.filter(isActive)} teams={data.teams ?? []} communications={data.communications ?? []} events={data.collaborations} selectedKey={selectedKey} onSelect={selectMember} now={now} reducedMotion={reducedMotion} fresh={freshness === "current"} />
                        ) : view === "pulse" ? (
                            <TeamPulse agents={agents.filter(isActive)} selectedKey={selectedKey} onSelect={selectMember} now={now} />
                        ) : view === "teams" ? (
                            <TeamStructure teams={data.teams ?? []} agents={agents.filter(isActive)} onSelect={selectMember} />
                        ) : (
                            <AgentList agents={agents} selectedKey={selectedKey} isActive={isActive} onSelect={selectMember} canAct={canAct} members={data.members} now={now} />
                        )}
                    </section>
                </div>

                <aside aria-label="Decisions and agent details" className="grid min-w-0 grid-cols-1 content-start gap-4 md:grid-cols-2 xl:grid-cols-1">
                    <div ref={inboxRef} className="scroll-mt-4"><NeedsAttention entries={actions} now={now} onFocusMember={focusMember} canAct={canAct} agents={agents.map((a) => a.member)} /></div>
                    <div ref={detailRef} className="scroll-mt-4"><SelectedAgent key={selectedAgent?.member.key} agent={selectedAgent} canAct={canAct} now={now} /></div>
                    {watchlist.length > 0 && <NeedsAttention entries={watchlist} watchlist now={now} onFocusMember={focusMember} canAct={canAct} agents={agents.map((a) => a.member)} />}
                </aside>
            </div>

            <MovementFeed feed={data.feed} now={now} isOwnerOrAdmin={isOwnerOrAdmin} />
            {kpi !== "attention" && <WorkBoard columns={columns} assignees={assignees} canAct={canAct} />}
        </div>
    );
}
