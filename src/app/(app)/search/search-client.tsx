"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
    IconBook, IconBuildingStore, IconFileText, IconFolder, IconListCheck, IconLoader2, IconMessage, IconRobot, IconSearch, IconX,
} from "@tabler/icons-react";
import { PageHeader } from "@/components/page-header";
import { isPlainKey, isTypingTarget } from "@/lib/keyboard-shortcuts";
import {
    SEARCH_MIN_QUERY_LENGTH, SEARCH_PAGE_LIMIT, SEARCH_TYPE_LABELS, SEARCH_TYPES, snippetParts,
    type SearchResponse, type SearchResult, type SearchType,
} from "@/lib/search-query";
import { timeAgo } from "@/lib/team-scene";
import { cn } from "@/lib/utils";

const TYPE_ICON: Record<SearchType, typeof IconSearch> = {
    task: IconListCheck,
    message: IconMessage,
    knowledge: IconBook,
    file: IconFileText,
    project: IconFolder,
    customer: IconBuildingStore,
    agent: IconRobot,
};

const DEBOUNCE_MS = 200;

type State = { query: string; type: SearchType | null; results: SearchResult[]; nextCursor: string | null };

function searchUrl(query: string, type: SearchType | null, cursor?: string | null) {
    const params = new URLSearchParams({ q: query, limit: String(SEARCH_PAGE_LIMIT) });
    if (type) params.set("type", type);
    if (cursor) params.set("cursor", cursor);
    return `/api/search?${params.toString()}`;
}

function pageUrl(query: string, type: SearchType | null) {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (type) params.set("type", type);
    const qs = params.toString();
    return qs ? `/search?${qs}` : "/search";
}

/** Matched words as <mark> text nodes; never HTML from the server. */
export function Snippet({ text, highlights, className }: { text: string; highlights: [number, number][]; className?: string }) {
    return (
        <span className={className}>
            {snippetParts(text, highlights).map((part, i) => part.match
                ? <mark key={i} className="rounded-[3px] bg-primary/15 px-0.5 font-medium text-foreground">{part.text}</mark>
                : <span key={i}>{part.text}</span>)}
        </span>
    );
}

export function SearchClient({ initialQuery, initialType, initial }: { initialQuery: string; initialType: SearchType | null; initial: SearchResponse | null }) {
    const router = useRouter();
    const inputRef = useRef<HTMLInputElement>(null);
    const listId = useId();
    const [query, setQuery] = useState(initialQuery);
    const [type, setType] = useState<SearchType | null>(initialType);
    const [state, setState] = useState<State | null>(initial ? { query: initial.query, type: initialType, results: initial.results, nextCursor: initial.nextCursor } : null);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [failed, setFailed] = useState(false);
    const [active, setActive] = useState(-1);
    const [now, setNow] = useState(() => new Date());
    const trimmed = query.trim();
    const searchable = trimmed.length >= SEARCH_MIN_QUERY_LENGTH;

    // Search as you type (debounced). The URL stays shareable; replaceState
    // (not router.replace) so typing never re-renders the server page.
    useEffect(() => {
        const url = pageUrl(trimmed, type);
        if (`${window.location.pathname}${window.location.search}` !== url) window.history.replaceState(window.history.state, "", url);
        if (!searchable) {
            setState(null);
            setLoading(false);
            setFailed(false);
            return;
        }
        if (state && state.query === trimmed && state.type === type) return;
        const controller = new AbortController();
        setLoading(true);
        const timer = window.setTimeout(async () => {
            try {
                const res = await fetch(searchUrl(trimmed, type), { signal: controller.signal, cache: "no-store" });
                if (!res.ok) throw new Error(String(res.status));
                const data = await res.json() as SearchResponse;
                setState({ query: trimmed, type, results: data.results, nextCursor: data.nextCursor });
                setFailed(false);
                setActive(-1);
                setNow(new Date());
            } catch {
                if (!controller.signal.aborted) setFailed(true);
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        }, DEBOUNCE_MS);
        return () => { controller.abort(); window.clearTimeout(timer); };
        // `state` is read only to skip a fetch the server already did.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [trimmed, type, searchable]);

    const loadMore = useCallback(async () => {
        if (!state?.nextCursor || loadingMore) return;
        setLoadingMore(true);
        try {
            const res = await fetch(searchUrl(state.query, state.type, state.nextCursor), { cache: "no-store" });
            if (!res.ok) throw new Error(String(res.status));
            const data = await res.json() as SearchResponse;
            setState((prev) => prev && prev.query === state.query && prev.type === state.type
                ? { ...prev, results: [...prev.results, ...data.results.filter((r) => !prev.results.some((p) => p.type === r.type && p.id === r.id))], nextCursor: data.nextCursor }
                : prev);
        } catch {
            setFailed(true);
        } finally {
            setLoadingMore(false);
        }
    }, [state, loadingMore]);

    // Grouped by type (in a fixed order), ranked within each group.
    const groups = useMemo(() => {
        const results = state?.results ?? [];
        return SEARCH_TYPES
            .map((t) => ({ type: t, items: results.filter((r) => r.type === t) }))
            .filter((g) => g.items.length > 0);
    }, [state]);
    const ordered = useMemo(() => groups.flatMap((g) => g.items), [groups]);
    const optionId = (index: number) => `${listId}-result-${index}`;

    useEffect(() => {
        if (active < 0) return;
        document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
        // optionId only depends on listId.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    const open = useCallback((result: SearchResult | undefined) => {
        if (result) router.push(result.href);
    }, [router]);

    const move = useCallback((delta: number) => {
        if (!ordered.length) return;
        setActive((i) => (i < 0 ? (delta > 0 ? 0 : ordered.length - 1) : Math.min(Math.max(i + delta, 0), ordered.length - 1)));
    }, [ordered.length]);

    const onInputKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
        else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
        else if (event.key === "Enter") { event.preventDefault(); open(ordered[active < 0 ? 0 : active]); }
        else if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); }
    };

    // Outside the box: `/` focuses it, j/k move, Enter opens.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.defaultPrevented || !isPlainKey(event) || isTypingTarget(event.target as HTMLElement | null)) return;
            if (document.querySelector("[role='dialog']")) return;
            if (event.key === "/") { event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); }
            else if (event.key === "j") { event.preventDefault(); move(1); }
            else if (event.key === "k") { event.preventDefault(); move(-1); }
            else if (event.key === "Enter" && active >= 0) { event.preventDefault(); open(ordered[active]); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [move, open, ordered, active]);

    const count = state?.results.length ?? 0;
    const status = !searchable
        ? trimmed ? `Type at least ${SEARCH_MIN_QUERY_LENGTH} characters.` : null
        : loading && !state ? "Searching…"
            : failed ? "Search failed. Try again in a moment."
                : state ? `${count}${state.nextCursor ? "+" : ""} result${count === 1 ? "" : "s"}` : null;

    return (
        <div className="mx-auto max-w-[1100px] space-y-5 pb-20 animate-in fade-in duration-500">
            <PageHeader
                eyebrow="Search"
                title="Search everything"
                description="Tasks and their notes, messages, Knowledge & Rules, files, projects, customers and agents you can open."
            />

            <div className="space-y-3">
                <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 shadow-sm focus-within:border-cyan-400/60 focus-within:ring-1 focus-within:ring-cyan-400/40 dark:bg-white/[0.03]">
                    {loading ? <IconLoader2 className="h-5 w-5 shrink-0 animate-spin text-muted-foreground" /> : <IconSearch className="h-5 w-5 shrink-0 text-muted-foreground" />}
                    <input
                        ref={inputRef}
                        type="search"
                        role="combobox"
                        aria-expanded={ordered.length > 0}
                        aria-controls={listId}
                        aria-autocomplete="list"
                        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
                        aria-label="Search"
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={onInputKey}
                        placeholder="Search tasks, messages, knowledge, files…"
                        maxLength={200}
                        className="h-12 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
                    />
                    {query && (
                        <button type="button" aria-label="Clear search" onClick={() => { setQuery(""); inputRef.current?.focus(); }}
                            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                            <IconX className="h-4 w-4" />
                        </button>
                    )}
                </div>

                <div role="toolbar" aria-label="Filter by type" className="flex flex-wrap gap-1.5">
                    {([null, ...SEARCH_TYPES] as (SearchType | null)[]).map((t) => {
                        const selected = type === t;
                        const Icon = t ? TYPE_ICON[t] : IconSearch;
                        return (
                            <button key={t ?? "all"} type="button" aria-pressed={selected} onClick={() => { setType(t); setActive(-1); }}
                                className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
                                    selected ? "border-primary/40 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground")}>
                                <Icon className={cn("h-4 w-4", selected ? "text-primary" : "text-muted-foreground")} />
                                {t ? SEARCH_TYPE_LABELS[t] : "All"}
                            </button>
                        );
                    })}
                </div>
                <p aria-live="polite" className="min-h-5 px-1 text-xs text-muted-foreground">{status}</p>
            </div>

            {!searchable ? (
                <EmptyState title="Find anything" body="Search by a few words. The last word matches as you type, and accents don't matter (cafe finds café)." />
            ) : state && ordered.length === 0 && !loading ? (
                <EmptyState title={`Nothing matches “${trimmed}”`} body={type ? `No ${SEARCH_TYPE_LABELS[type].toLowerCase()} match. Try All, or fewer words.` : "Try fewer or different words."} />
            ) : (
                <div id={listId} role="listbox" aria-label="Search results" className={cn("space-y-6 transition-opacity", loading && "opacity-60")}>
                    {groups.map((group) => {
                        const Icon = TYPE_ICON[group.type];
                        return (
                            <section key={group.type} role="group" aria-labelledby={`${listId}-${group.type}`}>
                                <header className="mb-2.5 flex items-baseline gap-2 px-1">
                                    <h2 id={`${listId}-${group.type}`} className="text-sm font-semibold text-foreground">{SEARCH_TYPE_LABELS[group.type]}</h2>
                                    <span className="text-xs tabular-nums text-muted-foreground">{group.items.length}</span>
                                </header>
                                <ul className="space-y-2">
                                    {group.items.map((result) => {
                                        const index = ordered.indexOf(result);
                                        const selected = index === active;
                                        return (
                                            <li key={`${result.type}:${result.id}`} id={optionId(index)} role="option" aria-selected={selected}>
                                                <Link href={result.href} onMouseMove={() => { if (!selected) setActive(index); }}
                                                    className={cn("flex gap-3 rounded-2xl border bg-card/60 p-3.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 sm:p-4 dark:bg-white/[0.02]",
                                                        selected ? "border-cyan-400/60 ring-1 ring-cyan-400/40" : "border-border/70 hover:border-border hover:bg-muted/40 dark:hover:bg-white/[0.035]")}>
                                                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground ring-1 ring-inset ring-border dark:bg-white/[0.04]">
                                                        <Icon className="h-[18px] w-[18px]" stroke={1.8} />
                                                    </span>
                                                    <span className="min-w-0 flex-1">
                                                        <span className="flex min-w-0 items-baseline gap-2">
                                                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{result.title}</span>
                                                            <time suppressHydrationWarning dateTime={result.updatedAt} className="shrink-0 text-xs tabular-nums text-muted-foreground">{timeAgo(result.updatedAt, now)}</time>
                                                        </span>
                                                        {result.context && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{result.context}</span>}
                                                        {result.snippet && (
                                                            <Snippet text={result.snippet} highlights={result.highlights} className="mt-1.5 line-clamp-2 block break-words text-sm leading-6 text-foreground/80" />
                                                        )}
                                                    </span>
                                                </Link>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </section>
                        );
                    })}
                    {state?.nextCursor && (
                        <div className="flex justify-center">
                            <button type="button" onClick={() => void loadMore()} disabled={loadingMore}
                                className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-4 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                                {loadingMore && <IconLoader2 className="h-4 w-4 animate-spin" />}Show more results
                            </button>
                        </div>
                    )}
                </div>
            )}

            {ordered.length > 0 && (
                <p className="hidden items-center gap-4 px-1 text-xs text-muted-foreground md:flex">
                    <Hint keys={["↑", "↓"]}>move</Hint>
                    <Hint keys={["Enter"]}>open</Hint>
                    <Hint keys={["/"]}>search</Hint>
                </p>
            )}
        </div>
    );
}

function Hint({ keys, children }: { keys: string[]; children: string }) {
    return (
        <span className="inline-flex items-center gap-1.5">
            {keys.map((k) => <kbd key={k} className="rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground dark:bg-white/[0.04]">{k}</kbd>)}
            <span>{children}</span>
        </span>
    );
}

function EmptyState({ title, body }: { title: string; body: string }) {
    return (
        <div className="rounded-2xl border border-dashed border-border px-6 py-14 text-center">
            <IconSearch className="mx-auto h-8 w-8 text-muted-foreground" stroke={1.6} />
            <h2 className="mt-3 text-base font-semibold text-foreground">{title}</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-muted-foreground">{body}</p>
        </div>
    );
}
