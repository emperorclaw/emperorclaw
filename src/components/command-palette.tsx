"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
    IconArrowRight, IconBook, IconBuildingStore, IconCommand, IconFileText, IconFolder, IconInbox, IconKeyboard, IconListCheck, IconMessage, IconMessagePlus, IconPlus, IconRobot,
    IconSearch, IconUserPlus,
} from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { CHORD_TIMEOUT_MS, GO_CHORDS, isPlainKey, isTypingTarget, matchesQuery } from "@/lib/keyboard-shortcuts";
import { navSections, type NavAccess } from "@/lib/navigation";
import type { PaletteData } from "@/lib/palette";
import { SEARCH_TYPE_LABELS, snippetParts, type SearchResult, type SearchType } from "@/lib/search-query";
import { cn } from "@/lib/utils";

const OPEN_EVENT = "emperor:open-palette";
const SHORTCUTS_EVENT = "emperor:open-shortcuts";

/** Open the palette from anywhere (the sidebar search pill, the phone header). */
export function openCommandPalette() {
    window.dispatchEvent(new Event(OPEN_EVENT));
}

export function openShortcutSheet() {
    window.dispatchEvent(new Event(SHORTCUTS_EVENT));
}

type Option = {
    id: string;
    group: string;
    label: string;
    hint?: string | null;
    href: string;
    icon: typeof IconSearch;
    keywords?: string;
    /** Full-text matches: the matched passage, highlighted as text nodes. */
    snippet?: { text: string; highlights: [number, number][] };
};

const MATCH_ICON: Record<SearchType, typeof IconSearch> = {
    task: IconListCheck,
    message: IconMessage,
    knowledge: IconBook,
    file: IconFileText,
    project: IconFolder,
    customer: IconBuildingStore,
    agent: IconRobot,
};

const EMPTY: PaletteData = { agents: [], projects: [], customers: [], tasks: [] };
const PER_GROUP = 6;

function isMac() {
    return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function CommandPalette({ access, canAct }: { access: NavAccess; canAct: boolean }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [data, setData] = useState<PaletteData>(EMPTY);
    // Server task and full-text matches for the current query (stale ones are ignored).
    const [found, setFound] = useState<{ q: string; tasks: PaletteData["tasks"]; matches: SearchResult[] } | null>(null);
    const [loading, setLoading] = useState(false);
    const [active, setActive] = useState(0);
    const listId = useId();
    const listRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const chordAt = useRef(0);

    // Global keys: Cmd/Ctrl+K anywhere; `?` and g-chords only outside text entry.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setOpen((value) => !value);
                return;
            }
            if (event.defaultPrevented || !isPlainKey(event) || isTypingTarget(event.target as HTMLElement | null)) return;
            if (document.querySelector("[role='dialog']")) return;
            if (event.key === "?") {
                event.preventDefault();
                setSheetOpen(true);
                return;
            }
            const now = Date.now();
            if (event.key === "g" && !event.shiftKey) {
                chordAt.current = now;
                return;
            }
            if (chordAt.current && now - chordAt.current < CHORD_TIMEOUT_MS) {
                chordAt.current = 0;
                const target = GO_CHORDS[event.key.toLowerCase()];
                if (target) {
                    event.preventDefault();
                    router.push(target.href);
                }
            }
        };
        const onOpen = () => setOpen(true);
        const onSheet = () => setSheetOpen(true);
        window.addEventListener("keydown", onKey);
        window.addEventListener(OPEN_EVENT, onOpen);
        window.addEventListener(SHORTCUTS_EVENT, onSheet);
        return () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener(OPEN_EVENT, onOpen);
            window.removeEventListener(SHORTCUTS_EVENT, onSheet);
        };
    }, [router]);

    // Records (and recent tasks) load once per opening; typed queries search
    // tasks on the server. The two never cancel each other.
    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        void (async () => {
            setLoading(true);
            try {
                const res = await fetch("/api/ui/palette", { signal: controller.signal, cache: "no-store" });
                if (res.ok) setData(await res.json() as PaletteData);
            } catch {
                // Offline or aborted: keep what we had.
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        })();
        return () => controller.abort();
    }, [open]);

    useEffect(() => {
        const q = query.trim();
        if (!open || !q) return;
        const controller = new AbortController();
        const timer = window.setTimeout(async () => {
            try {
                const res = await fetch(`/api/ui/palette?q=${encodeURIComponent(q)}`, { signal: controller.signal, cache: "no-store" });
                if (res.ok) {
                    const body = await res.json() as PaletteData;
                    setFound({ q, tasks: body.tasks, matches: body.matches ?? [] });
                }
            } catch {
                // Aborted by the next keystroke.
            }
        }, 160);
        return () => { controller.abort(); window.clearTimeout(timer); };
    }, [open, query]);

    const options = useMemo<Option[]>(() => {
        const q = query.trim();
        const actions: Option[] = [
            { id: "action:inbox", group: "Actions", label: "Open inbox", href: "/inbox", icon: IconInbox, keywords: "needs me approvals" },
            ...(canAct ? [
                { id: "action:new-task", group: "Actions", label: "New task", href: "/projects?new=task", icon: IconPlus, keywords: "create add task" },
                { id: "action:message", group: "Actions", label: "Message an agent", href: "/messages", icon: IconMessagePlus, keywords: "chat send" },
                { id: "action:hire", group: "Actions", label: "Hire agent", href: "/agents?hire=1", icon: IconUserPlus, keywords: "create new agent team" },
            ] : []),
        ];
        const pages: Option[] = [
            ...navSections(access).flatMap((section) => section.items).map((item) => ({
                id: `page:${item.href}`, group: "Pages", label: item.name, href: item.href, icon: IconArrowRight, keywords: item.keywords,
            })),
            { id: "page:/approvals", group: "Pages", label: "Approval history", href: "/approvals", icon: IconArrowRight, keywords: "decisions decided" },
        ];
        const records: Option[] = [
            ...data.agents.map((a) => ({ id: `agent:${a.id}`, group: "Agents", label: a.name, hint: a.role, href: `/agents?agent=${a.id}`, icon: IconRobot })),
            ...data.projects.map((p) => ({ id: `project:${p.id}`, group: "Projects", label: p.name, hint: p.customerName, href: `/projects?project=${p.id}`, icon: IconFolder })),
            ...data.customers.map((c) => ({ id: `customer:${c.id}`, group: "Customers", label: c.name, href: "/customers", icon: IconBuildingStore })),
        ];
        const tasks = q ? (found?.q === q ? found.tasks : []) : data.tasks;
        const taskOptions: Option[] = tasks.map((t) => ({ id: `task:${t.id}`, group: "Tasks", label: t.title, hint: t.projectName, href: `/projects?project=${t.projectId}&task=${t.id}`, icon: IconListCheck }));

        // Nothing typed: actions, recent tasks, then the main pages.
        if (!q) return [...actions, ...taskOptions.slice(0, 5).map((o) => ({ ...o, group: "Recent tasks" })), ...pages.filter((p) => ["/", "/inbox", "/messages", "/projects", "/agents"].includes(p.href))];
        const hit = (o: Option) => matchesQuery(`${o.label} ${o.hint ?? ""} ${o.keywords ?? ""}`, q);
        const limit = (list: Option[]) => {
            const counts = new Map<string, number>();
            return list.filter((o) => {
                const n = (counts.get(o.group) ?? 0) + 1;
                counts.set(o.group, n);
                return n <= PER_GROUP;
            });
        };
        // Tasks were already matched on the server.
        const listed = limit([...actions.filter(hit), ...pages.filter(hit), ...records.filter(hit), ...taskOptions]);
        // Full-text hits (tasks, notes, messages, knowledge, files…), minus what is already listed.
        const listedIds = new Set(listed.map((o) => o.id));
        const matches: Option[] = (found?.q === q ? found.matches : [])
            .filter((m) => !listedIds.has(`${m.type}:${m.id}`))
            .map((m) => ({
                id: `match:${m.type}:${m.id}`, group: "Matches", label: m.title, hint: SEARCH_TYPE_LABELS[m.type], href: m.href, icon: MATCH_ICON[m.type],
                snippet: m.snippet && m.highlights.length ? { text: m.snippet, highlights: m.highlights } : undefined,
            }));
        const searchRow: Option = { id: "search:all", group: "Search", label: `Search for “${q}”`, href: `/search?q=${encodeURIComponent(q)}`, icon: IconSearch };
        return [...listed, ...matches, searchRow];
    }, [query, data, found, access, canAct]);

    const groups = useMemo(() => {
        const out: { name: string; options: { option: Option; index: number }[] }[] = [];
        options.forEach((option, index) => {
            const group = out.find((g) => g.name === option.group) ?? out[out.push({ name: option.group, options: [] }) - 1];
            group.options.push({ option, index });
        });
        return out;
    }, [options]);

    const activeIndex = Math.min(active, Math.max(0, options.length - 1));
    const activeOption = options[activeIndex];
    const optionId = (index: number) => `${listId}-option-${index}`;

    useEffect(() => {
        if (!open) return;
        document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
        // optionId only depends on listId.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeIndex, open]);

    const choose = useCallback((option: Option | undefined) => {
        if (!option) return;
        setOpen(false);
        router.push(option.href);
    }, [router]);

    const onInputKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => (options.length ? (Math.min(i, options.length - 1) + 1) % options.length : 0)); }
        else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => (options.length ? (Math.min(i, options.length - 1) - 1 + options.length) % options.length : 0)); }
        else if (event.key === "Home" && event.ctrlKey) { event.preventDefault(); setActive(0); }
        else if (event.key === "End" && event.ctrlKey) { event.preventDefault(); setActive(Math.max(0, options.length - 1)); }
        else if (event.key === "Enter") { event.preventDefault(); choose(activeOption); }
    };

    const onOpenChange = (next: boolean) => {
        setOpen(next);
        if (!next) { setQuery(""); setActive(0); }
    };

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent
                    showCloseButton={false}
                    aria-describedby={undefined}
                    onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
                    className="top-3 flex max-h-[min(640px,calc(100dvh-1.5rem))] translate-y-0 flex-col gap-0 overflow-hidden border-border bg-popover p-0 text-foreground sm:top-[12vh] sm:max-w-xl dark:bg-zinc-950/95"
                >
                    <DialogTitle className="sr-only">Command palette</DialogTitle>
                    <div className="flex items-center gap-3 border-b border-border px-4">
                        <IconSearch className="h-5 w-5 shrink-0 text-muted-foreground" />
                        <input
                            ref={inputRef}
                            role="combobox"
                            aria-expanded="true"
                            aria-controls={listId}
                            aria-autocomplete="list"
                            aria-activedescendant={activeOption ? optionId(activeIndex) : undefined}
                            aria-label="Search pages, agents, projects, customers, tasks and messages"
                            value={query}
                            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
                            onKeyDown={onInputKey}
                            placeholder="Jump to a page, or search everything"
                            className="h-14 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-[15px]"
                        />
                        <kbd className="hidden rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline">Esc</kbd>
                    </div>
                    <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
                        {options.length === 0 ? (
                            <p className="px-3 py-10 text-center text-sm text-muted-foreground">{loading ? "Searching…" : `Nothing matches “${query.trim()}”.`}</p>
                        ) : groups.map((group) => (
                            <div key={group.name} role="group" aria-label={group.name} className="pb-1">
                                <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">{group.name}</div>
                                {group.options.map(({ option, index }) => {
                                    const selected = index === activeIndex;
                                    return (
                                        <div
                                            key={option.id}
                                            id={optionId(index)}
                                            role="option"
                                            aria-selected={selected}
                                            onMouseMove={() => { if (!selected) setActive(index); }}
                                            onClick={() => choose(option)}
                                            className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 text-sm sm:min-h-9", selected ? "bg-primary/10 text-foreground ring-1 ring-inset ring-primary/25" : "text-foreground/90")}
                                        >
                                            <option.icon className={cn("h-4 w-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />
                                            {option.snippet ? (
                                                <span className="min-w-0 flex-1 py-1.5">
                                                    <span className="block truncate">{option.label}</span>
                                                    <span className="block truncate text-xs text-muted-foreground">
                                                        {snippetParts(option.snippet.text, option.snippet.highlights).map((part, i) => part.match
                                                            ? <mark key={i} className="rounded-[3px] bg-primary/15 px-0.5 text-foreground">{part.text}</mark>
                                                            : <span key={i}>{part.text}</span>)}
                                                    </span>
                                                </span>
                                            ) : (
                                                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                                            )}
                                            {option.hint && <span className="hidden max-w-[45%] truncate text-xs text-muted-foreground sm:inline">{option.hint}</span>}
                                            {option.id === "search:all" && <IconArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                                            {selected && <kbd className="hidden rounded-md border border-border px-1.5 font-mono text-[11px] text-muted-foreground sm:inline">↵</kbd>}
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                    <div className="hidden items-center gap-4 border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground sm:flex">
                        <span className="inline-flex items-center gap-1.5"><kbd className="rounded border border-border px-1 font-mono">↑</kbd><kbd className="rounded border border-border px-1 font-mono">↓</kbd>move</span>
                        <span className="inline-flex items-center gap-1.5"><kbd className="rounded border border-border px-1 font-mono">↵</kbd>open</span>
                        <button type="button" onClick={() => { onOpenChange(false); setSheetOpen(true); }} className="ml-auto inline-flex items-center gap-1.5 rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                            <IconKeyboard className="h-3.5 w-3.5" />All shortcuts<kbd className="rounded border border-border px-1 font-mono">?</kbd>
                        </button>
                    </div>
                </DialogContent>
            </Dialog>
            <ShortcutSheet open={sheetOpen} onOpenChange={setSheetOpen} />
        </>
    );
}

function Keys({ keys }: { keys: string[] }) {
    return (
        <span className="flex shrink-0 items-center gap-1">
            {keys.map((k, i) => (
                <kbd key={`${k}-${i}`} className="min-w-6 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-center font-mono text-xs text-foreground dark:bg-white/[0.05]">{k}</kbd>
            ))}
        </span>
    );
}

function ShortcutSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const mod = isMac() ? "⌘" : "Ctrl";
    const rows: { label: string; keys: string[] }[] = [
        { label: "Open the command palette", keys: [mod, "K"] },
        { label: "Show this sheet", keys: ["?"] },
        ...Object.values(GO_CHORDS).map((c, i) => ({ label: `Go to ${c.label}`, keys: ["g", Object.keys(GO_CHORDS)[i]] })),
    ];
    const inbox: { label: string; keys: string[] }[] = [
        { label: "Next or previous item", keys: ["j", "k"] },
        { label: "Open the item", keys: ["Enter"] },
        { label: "Approve", keys: ["a"] },
        { label: "Reject with a note", keys: ["r"] },
    ];
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto border-border bg-popover text-foreground sm:max-w-md dark:bg-zinc-950/95">
                <DialogTitle className="flex items-center gap-2 text-foreground"><IconCommand className="h-5 w-5 text-primary" />Keyboard shortcuts</DialogTitle>
                <DialogDescription className="text-muted-foreground">Single keys work anywhere you are not typing.</DialogDescription>
                {[{ title: "Everywhere", rows }, { title: "In the inbox", rows: inbox }].map((section) => (
                    <section key={section.title}>
                        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{section.title}</h3>
                        <ul className="divide-y divide-border/60 rounded-xl border border-border">
                            {section.rows.map((row) => (
                                <li key={row.label} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                                    <span>{row.label}</span>
                                    <Keys keys={row.keys} />
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </DialogContent>
        </Dialog>
    );
}
