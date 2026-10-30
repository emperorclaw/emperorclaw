"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";
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
import { AUDIT_FIELD_LABELS, formatAuditValue, type AuditSentence } from "@/lib/audit-format";
import { useCopy } from "@/lib/i18n/use-copy";
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

// Labels: activity.targets.{key} in messages/*.json ("" is "everything").
const TARGET_OPTIONS = [
    { value: "", key: "everything" },
    { value: "agent", key: "agent" },
    { value: "task", key: "task" },
    { value: "approval", key: "approval" },
    { value: "project", key: "project" },
    { value: "customer", key: "customer" },
    { value: "knowledge_note", key: "knowledge_note" },
    { value: "member", key: "member" },
    { value: "invitation", key: "invitation" },
    { value: "company", key: "company" },
    { value: "organization", key: "organization" },
    { value: "pricing", key: "pricing" },
] as const;

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

async function fetchPage(filters: Filters, cursor: string | null, failed: string): Promise<ActivityPage> {
    const res = await fetch(`/api/activity?${queryFor(filters, cursor)}`, { cache: "no-store" });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || failed);
    return res.json();
}

function dayKey(iso: string): string {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Day headings and relative times, in the viewer's language. */
function useFeedTime() {
    const t = useTranslations("activity");
    const tTime = useTranslations("time");
    const format = useFormatter();
    const dayLabel = (iso: string, now: Date): string => {
        const d = new Date(iso);
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const days = Math.round((today.getTime() - that.getTime()) / 86_400_000);
        if (days === 0) return t("today");
        if (days === 1) return t("yesterday");
        return format.dateTime(d, { weekday: "long", month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
    };
    const relativeTime = (iso: string, now: Date): string => {
        const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
        if (seconds < 60) return tTime("justNow");
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return tTime("minutesAgo", { count: minutes });
        const hours = Math.round(minutes / 60);
        if (hours < 24) return tTime("hoursAgo", { count: hours });
        return format.dateTime(new Date(iso), { hour: "numeric", minute: "2-digit" });
    };
    const fullTime = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "medium" });
    return { dayLabel, relativeTime, fullTime };
}

/** Consecutive rows of one bulk change (same batch id) render as one entry. */
type FeedEntry = { key: string; items: ActivityItem[] };

function groupFeed(items: ActivityItem[], now: Date, dayLabel: (iso: string, now: Date) => string): { day: string; label: string; entries: FeedEntry[] }[] {
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
    const t = useTranslations("activity");
    const keys = [...new Set([...Object.keys(item.before ?? {}), ...Object.keys(item.after ?? {})])]
        .filter((key) => key !== "archived");
    if (keys.length === 0 || !item.before) return null;
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button type="button" className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                    {t("changes")} <IconChevronDown className="h-3 w-3" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 border-border bg-popover">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("whatChanged")}</p>
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

function TargetLink({ item, children }: { item: ActivityItem; children: ReactNode }) {
    return item.href
        ? <Link href={item.href} className="font-medium text-foreground underline-offset-2 hover:text-cyan-500 hover:underline">{children}</Link>
        : <span className="font-medium text-foreground">{children}</span>;
}

function TargetLabel({ item }: { item: ActivityItem }) {
    const render = useCopy();
    const { label, labelCopy } = item.sentence;
    if (!label) return null;
    return <TargetLink item={item}>{render(labelCopy, label)}</TargetLink>;
}

type SentenceValue = string | ((chunks: ReactNode) => ReactNode);
type RichTranslator = {
    rich(key: string, values: Record<string, SentenceValue>): ReactNode;
    has(key: string): boolean;
};

/**
 * The sentence from its template (activity.sentences.<action>), so each
 * language keeps its own word order; null when the action has no template or
 * the template cannot render, and the caller shows the English parts.
 * `target` wraps the noun and label (a link, or the count of a grouped row).
 */
function useAuditSentence() {
    const t = useTranslations() as unknown as RichTranslator;
    const render = useCopy();
    return useCallback((sentence: AuditSentence, target: (chunks: ReactNode) => ReactNode): ReactNode | null => {
        const key = sentence.sentenceKey;
        if (!key || !t.has(key)) return null;
        try {
            const out = t.rich(key, {
                actor: render(sentence.actorCopy, sentence.actor),
                label: render(sentence.labelCopy, sentence.label ?? ""),
                detail: render(sentence.detailCopy, sentence.detail ?? ""),
                who: (chunks) => <span className="font-semibold text-foreground">{chunks}</span>,
                target,
            });
            // next-intl reports a formatting error and returns the key instead of throwing.
            return out === key ? null : out;
        } catch {
            return null;
        }
    }, [t, render]);
}

function FeedRow({ entry, names, now }: { entry: FeedEntry; names: Record<string, string>; now: Date }) {
    const t = useTranslations("activity");
    const { relativeTime, fullTime } = useFeedTime();
    const auditSentence = useAuditSentence();
    const [open, setOpen] = useState(false);
    const item = entry.items[0];
    const TargetIcon = TARGET_ICONS[item.targetType] ?? IconHistory;
    const many = entry.items.length > 1;
    const { sentence } = item;
    const countButton = (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
            className="font-medium text-foreground underline-offset-2 hover:underline">
            {item.targetType === "task" ? t("taskCount", { count: entry.items.length }) : t("itemCount", { count: entry.items.length })}
        </button>
    );
    const coded = auditSentence(sentence, (chunks) => many ? countButton : <TargetLink item={item}>{chunks}</TargetLink>);
    return (
        <li className="flex gap-3 px-4 py-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground" aria-hidden>
                <TargetIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
                <p className="text-sm leading-6 text-muted-foreground">
                    {coded ?? (
                        <>
                            <span className="font-semibold text-foreground">{sentence.actor}</span>{" "}
                            {sentence.verb}{" "}
                            {many ? countButton : <>{sentence.noun && <>{sentence.noun} </>}<TargetLabel item={item} /></>}
                            {sentence.detail && <> {sentence.detail}</>}
                        </>
                    )}
                </p>
                {many && open && (
                    <ul className="mt-1 space-y-0.5 border-l border-border pl-3 text-sm">
                        {entry.items.map((child) => <li key={child.id}><TargetLabel item={child} /></li>)}
                    </ul>
                )}
                <p className="text-xs text-muted-foreground">
                    <time dateTime={item.createdAt} title={fullTime(item.createdAt)}>{relativeTime(item.createdAt, now)}</time>
                    {item.actor.type === "agent" && ` · ${t("byAgent")}`}
                    {item.actor.type === "system" && ` · ${t("byAutomation")}`}
                </p>
            </div>
            {!many && <div className="shrink-0 self-start"><DiffPopover item={item} names={names} /></div>}
        </li>
    );
}

function FeedSkeleton() {
    const t = useTranslations("activity");
    return (
        <div className="overflow-hidden rounded-2xl border border-border bg-card" role="status" aria-busy="true" aria-label={t("loading")}>
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
    const t = useTranslations("activity");
    const { dayLabel } = useFeedTime();
    const loadFailed = t("loadFailed");
    const targetOptions = TARGET_OPTIONS.map((option) => ({ value: option.value, label: t(`targets.${option.key}`) }));
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
        { value: "", label: t("actors.anyone") },
        { value: "type:human", label: t("actors.allPeople") },
        { value: "type:agent", label: t("actors.allAgents") },
        { value: "type:system", label: t("actors.automation") },
        ...people.map((p) => ({ value: `human:${p.id}`, label: p.name, description: t("actors.person") })),
        ...agents.map((a) => ({ value: `agent:${a.id}`, label: a.name, description: t("actors.agent") })),
    ], [people, agents, t]);

    const reload = useCallback(async (next: Filters) => {
        filtersRef.current = next;
        setLoading(true);
        setError(null);
        try {
            const page = await fetchPage(next, null, loadFailed);
            if (filtersRef.current !== next) return;
            setItems(page.items);
            setNames(page.names);
            setCursor(page.nextCursor);
        } catch (e) {
            if (filtersRef.current === next) setError(e instanceof Error ? e.message : loadFailed);
        } finally {
            if (filtersRef.current === next) setLoading(false);
        }
    }, [loadFailed]);

    useEffect(() => {
        if (firstRender.current) { firstRender.current = false; return; }
        void reload(filters);
    }, [filters, reload]);

    // New entries arrive at the top; pages already loaded below stay put.
    const refreshTop = useCallback(async () => {
        const current = filtersRef.current;
        try {
            const page = await fetchPage(current, null, loadFailed);
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
    }, [loadFailed]);
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
            const page = await fetchPage(current, cursor, loadFailed);
            if (filtersRef.current !== current) return;
            setNames((prev) => ({ ...prev, ...page.names }));
            setItems((prev) => {
                const known = new Set(prev.map((i) => i.id));
                return [...prev, ...page.items.filter((i) => !known.has(i.id))];
            });
            setCursor(page.nextCursor);
        } catch (e) {
            setError(e instanceof Error ? e.message : t("loadOlderFailed"));
        } finally {
            setLoadingMore(false);
        }
    };

    const groups = now ? groupFeed(items, now, dayLabel) : [];
    const hasFilter = filters.actor !== "" || filters.targetType !== "" || filters.from !== "" || filters.to !== "";
    const dateInput = "h-10 rounded-lg border border-border bg-background px-2 text-sm text-foreground [color-scheme:light] dark:[color-scheme:dark]";

    return (
        <div className="mx-auto max-w-4xl space-y-6 pb-12">
            <PageHeader eyebrow={t("eyebrow")} title={t("title")}
                description={t("description")} />

            <div className="flex flex-wrap items-end gap-2" role="group" aria-label={t("filterLabel")}>
                <label className="space-y-1">
                    <span className="block text-xs text-muted-foreground">{t("who")}</span>
                    <SearchableSelect value={filters.actor} onChange={(v) => setFilters((f) => ({ ...f, actor: v }))}
                        options={actorOptions} placeholder={t("actors.anyone")} searchPlaceholder={t("findActor")} className="min-w-[170px]" />
                </label>
                <label className="space-y-1">
                    <span className="block text-xs text-muted-foreground">{t("what")}</span>
                    <SearchableSelect value={filters.targetType} onChange={(v) => setFilters((f) => ({ ...f, targetType: v }))}
                        options={targetOptions} placeholder={t("targets.everything")} className="min-w-[160px]" />
                </label>
                <label className="space-y-1">
                    <span className="block text-xs text-muted-foreground">{t("from")}</span>
                    <input type="date" value={filters.from} max={filters.to || undefined}
                        onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} className={dateInput} />
                </label>
                <label className="space-y-1">
                    <span className="block text-xs text-muted-foreground">{t("to")}</span>
                    <input type="date" value={filters.to} min={filters.from || undefined}
                        onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} className={dateInput} />
                </label>
                {hasFilter && (
                    <button type="button" onClick={() => setFilters(NO_FILTERS)}
                        className="h-9 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
                        {t("clear")}
                    </button>
                )}
            </div>

            {error && <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-500">{error}</p>}

            {loading || !now ? <FeedSkeleton /> : items.length === 0 ? (
                <EmptyState
                    icon={IconHistory}
                    title={hasFilter ? t("noMatchesTitle") : t("emptyTitle")}
                    description={hasFilter ? t("noMatchesDescription") : t("emptyDescription")}
                    action={hasFilter && <button type="button" onClick={() => setFilters(NO_FILTERS)} className="h-9 rounded-lg border border-border px-3 text-sm text-foreground hover:bg-muted">{t("clearFilters")}</button>}
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
                                {loadingMore ? t("loadingMore") : t("loadOlder")}
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
