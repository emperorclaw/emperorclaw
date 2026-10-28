"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    IconArrowRight,
    IconBuildingStore,
    IconChecks,
    IconChevronDown,
    IconCoin,
    IconFolder,
    IconHistory,
    IconListCheck,
    IconMailPlus,
    IconNotes,
    IconRobot,
    IconSettings,
    IconSitemap,
    IconUser,
    type Icon,
} from "@tabler/icons-react";
import { PageHeader } from "@/components/page-header";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useRealtimeTopics } from "@/lib/use-realtime";
import { AUDIT_FIELD_LABELS, formatAuditValue } from "@/lib/audit-format";
import type { ActivityItem, ActivityPage } from "@/lib/audit-reads";
import { cn } from "@/lib/utils";

type Person = { id: string; name: string };

const LIVE_TOPICS = ["activity"] as const;

const TARGET_ICONS: Record<string, Icon> = {
    agent: IconRobot,
    task: IconListCheck,
    approval: IconChecks,
    member: IconUser,
    invitation: IconMailPlus,
    company: IconSettings,
    organization: IconSitemap,
    project: IconFolder,
    customer: IconBuildingStore,
    knowledge_note: IconNotes,
    pricing: IconCoin,
};

const TARGET_OPTIONS = [
    { value: "", label: "Everything" },
    { value: "agent", label: "Agents" },
    { value: "task", label: "Tasks" },
    { value: "approval", label: "Approvals" },
    { value: "project", label: "Projects" },
    { value: "customer", label: "Customers" },
    { value: "knowledge_note", label: "Knowledge notes" },
    { value: "member", label: "People" },
    { value: "invitation", label: "Invitations" },
    { value: "company", label: "Company settings" },
    { value: "organization", label: "Org chart" },
    { value: "pricing", label: "Model pricing" },
];

type Filters = { actor: string; targetType: string; from: string; to: string };
const NO_FILTERS: Filters = { actor: "", targetType: "", from: "", to: "" };

/** The query string for a filter set; dates are local days, sent as UTC instants. */
function queryFor(filters: Filters, cursor: string | null): string {
    const params = new URLSearchParams();
    const [kind, id] = filters.actor.split(":");
    if (kind === "type" && id) params.set("actorType", id);
    else if ((kind === "human" || kind === "agent") && id) { params.set("actorType", kind); params.set("actorId", id); }
    if (filters.targetType) params.set("targetType", filters.targetType);
    if (filters.from) params.set("from", new Date(`${filters.from}T00:00:00`).toISOString());
    if (filters.to) params.set("to", new Date(`${filters.to}T23:59:59.999`).toISOString());
    if (cursor) params.set("cursor", cursor);
    return params.toString();
}

async function fetchPage(filters: Filters, cursor: string | null): Promise<ActivityPage> {
    const res = await fetch(`/api/activity?${queryFor(filters, cursor)}`, { cache: "no-store" });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || "Could not load activity");
    return res.json();
}

function dayKey(iso: string): string {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string, now: Date): string {
    const d = new Date(iso);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const days = Math.round((today.getTime() - that.getTime()) / 86_400_000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

function relativeTime(iso: string, now: Date): string {
    const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Consecutive rows of one bulk change (same batch id) render as one entry. */
type FeedEntry = { key: string; items: ActivityItem[] };

function groupFeed(items: ActivityItem[], now: Date): { day: string; label: string; entries: FeedEntry[] }[] {
    const days: { day: string; label: string; entries: FeedEntry[] }[] = [];
    for (const item of items) {
        const day = dayKey(item.createdAt);
        let group = days.at(-1);
        if (!group || group.day !== day) {
            group = { day, label: dayLabel(item.createdAt, now), entries: [] };
            days.push(group);
        }
        const last = group.entries.at(-1);
        if (item.batch && last && last.items[0].batch === item.batch) last.items.push(item);
        else group.entries.push({ key: item.id, items: [item] });
    }
    return days;
}

function DiffPopover({ item, names }: { item: ActivityItem; names: Record<string, string> }) {
    const keys = [...new Set([...Object.keys(item.before ?? {}), ...Object.keys(item.after ?? {})])]
        .filter((key) => key !== "archived");
    if (keys.length === 0 || !item.before) return null;
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button type="button" className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                    Changes <IconChevronDown className="h-3 w-3" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 border-border bg-popover">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">What changed</p>
                <dl className="space-y-2">
                    {keys.map((key) => (
                        <div key={key} className="space-y-0.5">
                            <dt className="text-xs text-muted-foreground">{AUDIT_FIELD_LABELS[key] ?? key}</dt>
                            <dd className="flex flex-wrap items-center gap-1.5 text-sm">
                                <span className="text-muted-foreground line-through decoration-muted-foreground/50">{formatAuditValue(key, item.before?.[key], names)}</span>
                                <IconArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                                <span className="font-medium text-foreground">{formatAuditValue(key, item.after?.[key], names)}</span>
                            </dd>
                        </div>
                    ))}
                </dl>
            </PopoverContent>
        </Popover>
    );
}

function TargetLabel({ item }: { item: ActivityItem }) {
    const { label } = item.sentence;
    if (!label) return null;
    return item.href
        ? <Link href={item.href} className="font-medium text-foreground underline-offset-2 hover:text-cyan-500 hover:underline">{label}</Link>
        : <span className="font-medium text-foreground">{label}</span>;
}

function FeedRow({ entry, names, now }: { entry: FeedEntry; names: Record<string, string>; now: Date }) {
    const [open, setOpen] = useState(false);
    const item = entry.items[0];
    const TargetIcon = TARGET_ICONS[item.targetType] ?? IconHistory;
    const many = entry.items.length > 1;
    const { sentence } = item;
    return (
        <li className="flex gap-3 px-4 py-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground" aria-hidden>
                <TargetIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
                <p className="text-sm leading-6 text-muted-foreground">
                    <span className="font-semibold text-foreground">{sentence.actor}</span>{" "}
                    {sentence.verb}{" "}
                    {many ? (
                        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
                            className="font-medium text-foreground underline-offset-2 hover:underline">
                            {entry.items.length} {item.targetType === "task" ? "tasks" : "items"}
                        </button>
                    ) : (
                        <>{sentence.noun && <>{sentence.noun} </>}<TargetLabel item={item} /></>
                    )}
                    {sentence.detail && <> {sentence.detail}</>}
                </p>
                {many && open && (
                    <ul className="mt-1 space-y-0.5 border-l border-border pl-3 text-sm">
                        {entry.items.map((child) => <li key={child.id}><TargetLabel item={child} /></li>)}
                    </ul>
                )}
                <p className="text-xs text-muted-foreground">
                    <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt, now)}</time>
                    {item.actor.type === "agent" && " · agent"}
                    {item.actor.type === "system" && " · automation"}
                </p>
            </div>
            {!many && <div className="shrink-0 self-start"><DiffPopover item={item} names={names} /></div>}
        </li>
    );
}

function FeedSkeleton() {
    return (
        <div className="overflow-hidden rounded-2xl border border-border bg-card" role="status" aria-busy="true" aria-label="Loading activity">
            {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="flex gap-3 border-b border-border px-4 py-3 last:border-b-0">
                    <Skeleton className="h-8 w-8 rounded-lg" />
                    <div className="flex-1 space-y-2 py-1">
                        <Skeleton className="h-3 w-2/3" />
                        <Skeleton className="h-2.5 w-20" />
                    </div>
                </div>
            ))}
        </div>
    );
}

export function ActivityClient({ initial, people, agents }: { initial: ActivityPage; people: Person[]; agents: Person[] }) {
    const [filters, setFilters] = useState<Filters>(NO_FILTERS);
    const [items, setItems] = useState<ActivityItem[]>(initial.items);
    const [names, setNames] = useState<Record<string, string>>(initial.names);
    const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Day groups and times are in the viewer's timezone and locale, so the feed
    // renders after hydration (the server's clock and locale may differ).
    const [now, setNow] = useState<Date | null>(null);
    const filtersRef = useRef(filters);
    const firstRender = useRef(true);

    const actorOptions = useMemo(() => [
        { value: "", label: "Anyone" },
        { value: "type:human", label: "All people" },
        { value: "type:agent", label: "All agents" },
        { value: "type:system", label: "Automation" },
        ...people.map((p) => ({ value: `human:${p.id}`, label: p.name, description: "Person" })),
        ...agents.map((a) => ({ value: `agent:${a.id}`, label: a.name, description: "Agent" })),
    ], [people, agents]);

    const reload = useCallback(async (next: Filters) => {
        filtersRef.current = next;
        setLoading(true);
        setError(null);
        try {
            const page = await fetchPage(next, null);
            if (filtersRef.current !== next) return;
            setItems(page.items);
            setNames(page.names);
            setCursor(page.nextCursor);
        } catch (e) {
            if (filtersRef.current === next) setError(e instanceof Error ? e.message : "Could not load activity");
        } finally {
            if (filtersRef.current === next) setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (firstRender.current) { firstRender.current = false; return; }
        void reload(filters);
    }, [filters, reload]);

    // New entries arrive at the top; pages already loaded below stay put.
    const refreshTop = useCallback(async () => {
        const current = filtersRef.current;
        try {
            const page = await fetchPage(current, null);
            if (filtersRef.current !== current) return;
            setNames((prev) => ({ ...prev, ...page.names }));
            setItems((prev) => {
                const known = new Set(prev.map((i) => i.id));
                const fresh = page.items.filter((i) => !known.has(i.id));
                return fresh.length > 0 ? [...fresh, ...prev] : prev;
            });
        } catch {
            // The next invalidation or a filter change retries.
        }
        setNow(new Date());
    }, []);
    useRealtimeTopics(LIVE_TOPICS, refreshTop);

    useEffect(() => {
        setNow(new Date());
        const timer = setInterval(() => setNow(new Date()), 60_000);
        return () => clearInterval(timer);
    }, []);

    const loadMore = async () => {
        if (!cursor) return;
        const current = filtersRef.current;
        setLoadingMore(true);
        try {
            const page = await fetchPage(current, cursor);
            if (filtersRef.current !== current) return;
            setNames((prev) => ({ ...prev, ...page.names }));
            setItems((prev) => {
                const known = new Set(prev.map((i) => i.id));
                return [...prev, ...page.items.filter((i) => !known.has(i.id))];
            });
            setCursor(page.nextCursor);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not load older activity");
        } finally {
            setLoadingMore(false);
        }
    };

    const groups = useMemo(() => (now ? groupFeed(items, now) : []), [items, now]);
    const hasFilter = filters.actor !== "" || filters.targetType !== "" || filters.from !== "" || filters.to !== "";
    const dateInput = "h-10 rounded-lg border border-border bg-background px-2 text-sm text-foreground [color-scheme:light] dark:[color-scheme:dark]";

    return (
        <div className="mx-auto max-w-4xl space-y-6 pb-12">
            <PageHeader eyebrow="Org" title="Activity"
                description="Who changed what: agent settings, budgets and scope, task moves and assignees, approvals, people, projects, customers and knowledge notes. Only titles, names, states and numbers are kept, never message text or secrets." />

            <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Filter activity">
                <label className="space-y-1">
                    <span className="block text-xs text-muted-foreground">Who</span>
                    <SearchableSelect value={filters.actor} onChange={(v) => setFilters((f) => ({ ...f, actor: v }))}
                        options={actorOptions} placeholder="Anyone" searchPlaceholder="Find a person or agent" className="min-w-[170px]" />
                </label>
                <label className="space-y-1">
                    <span className="block text-xs text-muted-foreground">What</span>
                    <SearchableSelect value={filters.targetType} onChange={(v) => setFilters((f) => ({ ...f, targetType: v }))}
                        options={TARGET_OPTIONS} placeholder="Everything" className="min-w-[160px]" />
                </label>
                <label className="space-y-1">
                    <span className="block text-xs text-muted-foreground">From</span>
                    <input type="date" value={filters.from} max={filters.to || undefined}
                        onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} className={dateInput} />
                </label>
                <label className="space-y-1">
                    <span className="block text-xs text-muted-foreground">To</span>
                    <input type="date" value={filters.to} min={filters.from || undefined}
                        onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} className={dateInput} />
                </label>
                {hasFilter && (
                    <button type="button" onClick={() => setFilters(NO_FILTERS)}
                        className="h-9 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
                        Clear
                    </button>
                )}
            </div>

            {error && <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-500">{error}</p>}

            {loading || !now ? <FeedSkeleton /> : items.length === 0 ? (
                <EmptyState
                    icon={IconHistory}
                    title={hasFilter ? "No activity matches these filters" : "No activity yet"}
                    description={hasFilter ? "Nothing was recorded for this person, agent or date range. Try a wider range." : "Changes to agents, tasks, approvals, people and settings show up here as they happen."}
                    action={hasFilter && <button type="button" onClick={() => setFilters(NO_FILTERS)} className="h-9 rounded-lg border border-border px-3 text-sm text-foreground hover:bg-muted">Clear filters</button>}
                />
            ) : (
                <div className="space-y-6">
                    {groups.map((group) => (
                        <section key={group.day} aria-label={group.label}>
                            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</h2>
                            <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
                                {group.entries.map((entry) => <FeedRow key={entry.key} entry={entry} names={names} now={now} />)}
                            </ul>
                        </section>
                    ))}
                    {cursor && (
                        <div className="flex justify-center">
                            <button type="button" onClick={() => void loadMore()} disabled={loadingMore}
                                className={cn("min-h-10 rounded-xl border border-border bg-card px-4 text-sm text-foreground hover:bg-muted disabled:opacity-60")}>
                                {loadingMore ? "Loading…" : "Load older activity"}
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
