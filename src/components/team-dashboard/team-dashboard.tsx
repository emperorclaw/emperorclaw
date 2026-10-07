"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { IconBox, IconDotsVertical, IconLayoutList, IconSearch, IconX } from "@tabler/icons-react";
import {
    buildOfficeLayout, collaborationLinks, defaultSelection, deriveSceneAgents, kpiCounts, matchesKpi, matchesQuery, taskMatchesQuery, ZONES,
    type DashboardData, type DashboardTask, type KpiFilter, type SceneAgent, type ZoneId,
} from "@/lib/team-scene";
import { NotificationBell } from "@/components/notification-bell";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { AgentList } from "./agent-list";
import { KpiRow } from "./kpi-row";
import { NeedsAttention } from "./needs-attention";
import { OfficeScene, SceneEmptyState } from "./office-scene";
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

/** Container: owns filters and selection, derives everything else from server data. */
export function TeamDashboard({ data, initialView = "scene", workFilter, hasAgents }: { data: DashboardData; initialView?: "scene" | "list"; workFilter?: ReactNode; hasAgents: boolean }) {
    const [view, setView] = useState<"scene" | "list">(initialView);
    const [kpi, setKpi] = useState<KpiFilter | null>(null);
    const [query, setQuery] = useState("");
    const [zoneFilter, setZoneFilter] = useState<ZoneId | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [hovered, setHovered] = useState<string | null>(null);
    const reducedMotion = usePrefersReducedMotion();
    const searchRef = useRef<HTMLInputElement>(null);
    const now = useMemo(() => new Date(data.generatedAt), [data.generatedAt]);

    const agents = useMemo(() => deriveSceneAgents(data), [data]);
    const layout = useMemo(() => buildOfficeLayout(agents), [agents]);
    const links = useMemo(() => collaborationLinks(data.collaborations, layout.agents), [data.collaborations, layout.agents]);
    const counts = useMemo(() => kpiCounts(agents, data), [agents, data]);
    const byKey = useMemo(() => new Map(agents.map((a) => [a.member.key, a])), [agents]);

    const isActive = useCallback((agent: SceneAgent) => matchesKpi(kpi, agent.member, agent.status) && matchesQuery(agent, query) && (!zoneFilter || agent.zone === zoneFilter), [kpi, query, zoneFilter]);

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
    const columns = useMemo(() => {
        const keep = (t: DashboardTask) => {
            const assignee = t.assigneeKey ? assignees.get(t.assigneeKey) : null;
            if (!taskMatchesQuery(t, assignee?.member.name ?? null, query)) return false;
            if (!t.assigneeKey) return !kpi && !zoneFilter;
            const agent = byKey.get(t.assigneeKey);
            return agent ? isActive(agent) || (!kpi && !zoneFilter) : !kpi && !zoneFilter;
        };
        return { inProgress: data.board.inProgress.filter(keep), review: data.board.review.filter(keep), done: data.board.done.filter(keep) };
    }, [data.board, assignees, byKey, isActive, kpi, zoneFilter, query]);

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

    const selectMember = (key: string) => setSelected(key);
    const focusMember = (key: string) => {
        setSelected(key);
        setKpi(null);
        setZoneFilter(null);
    };

    return (
        <div className="space-y-5">
            <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                    <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-[2.1rem]">Your team, in motion</h1>
                    <p className="mt-1 text-base text-muted-foreground">See what is moving. Step in where it matters.</p>
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
                    <KpiRow counts={counts} active={kpi} onToggle={(id) => setKpi((cur) => (cur === id ? null : id))} />

                    <section aria-labelledby="live-workspace-title" className="emperor-panel rounded-2xl p-3 sm:p-4">
                        <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-2.5">
                                <IconBox className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" stroke={1.8} />
                                <div className="min-w-0">
                                    <h2 id="live-workspace-title" className="flex items-center gap-2 text-base font-semibold text-foreground">
                                        Live workspace
                                        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-emerald-600 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-300">
                                            <span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden" /><span className="relative h-1.5 w-1.5 rounded-full bg-emerald-400" /></span>
                                            LIVE
                                        </span>
                                    </h2>
                                    <p className="text-xs text-muted-foreground">Your agents, projects and work, in real time.</p>
                                </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                {workFilter}
                                <div role="tablist" aria-label="Workspace view" className="flex rounded-xl border border-border bg-muted/40 p-0.5 dark:bg-white/[0.03]">
                                    {([["scene", "Scene", IconBox], ["list", "List", IconLayoutList]] as const).map(([id, label, Icon]) => (
                                        <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
                                            className={cn("inline-flex min-h-8 items-center gap-1.5 rounded-[10px] px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
                                                view === id ? "bg-cyan-500/15 text-cyan-700 ring-1 ring-inset ring-cyan-500/40 dark:text-cyan-200" : "text-muted-foreground hover:text-foreground")}>
                                            <Icon className="h-4 w-4" stroke={1.8} />{label}
                                        </button>
                                    ))}
                                </div>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <button type="button" aria-label="Workspace options" className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"><IconDotsVertical className="h-4 w-4" /></button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-52">
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
                            <OfficeScene layout={layout} links={links} selectedKey={selectedKey} hoveredKey={hovered} isActive={isActive} reducedMotion={reducedMotion}
                                onSelect={selectMember} onHover={setHovered} onOverflow={(zone) => { setZoneFilter(zone); setView("list"); }}
                                emptyState={hasAgents ? undefined : <SceneEmptyState />} />
                        ) : (
                            <AgentList agents={agents} selectedKey={selectedKey} isActive={isActive} onSelect={selectMember} />
                        )}
                    </section>
                </div>

                <aside aria-label="Details" className="grid min-w-0 content-start gap-4 md:grid-cols-2 xl:grid-cols-1">
                    <NeedsAttention entries={data.attention} now={now} onFocusMember={focusMember} />
                    <SelectedAgent agent={selectedAgent} />
                </aside>
            </div>

            <WorkBoard columns={columns} assignees={assignees} activity={data.activity} now={now} />
        </div>
    );
}
