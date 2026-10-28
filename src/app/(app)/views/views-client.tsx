"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { IconArchive, IconLayoutDashboard, IconMessageCircle, IconPlus, IconSearch } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useNowMs } from "@/components/views/view-panels";
import { ViewRow } from "@/components/views/view-meta";
import type { ViewSummary } from "@/lib/views";
import { VIEW_DESCRIPTION_MAX, VIEW_TITLE_MAX } from "@/lib/view-spec";
import { cn } from "@/lib/utils";

export { scopeText } from "@/components/views/view-meta";

const EXAMPLE_ASKS = [
    "Build me a view of this month's e-shop products",
    "Build me a view of our finances for the last 7 days",
    "Build me a view of open leads by stage, refreshed daily",
];

/** The empty state teaches the one way views get built: ask an agent. */
export function ViewsEmptyState() {
    return (
        <EmptyState
            icon={IconLayoutDashboard}
            title="No views yet"
            description={<>Views are dashboards your agents build and keep fresh. Ask an agent: &ldquo;Build me a view of &hellip;&rdquo; and it creates the page, fills in the numbers and refreshes them on a schedule.</>}
            action={
                <Link href="/messages" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-foreground hover:bg-accent">
                    <IconMessageCircle className="h-4 w-4" aria-hidden />Open chat
                </Link>
            }
        >
            <ul className="mx-auto mt-3 flex w-full max-w-xl flex-col gap-2 text-left text-sm">
                {EXAMPLE_ASKS.map((ask) => (
                    <li key={ask} className="rounded-xl border border-border bg-background px-3 py-2 text-foreground">&ldquo;{ask}&rdquo;</li>
                ))}
            </ul>
        </EmptyState>
    );
}

const FILTERS = [
    { key: "all", label: "All" },
    { key: "mine", label: "Mine" },
    { key: "shared", label: "Shared with me" },
    { key: "pinned", label: "Pinned" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

type Group = { key: string; title: string; views: ViewSummary[]; projects: { key: string; title: string; views: ViewSummary[] }[] };

/**
 * Company first, then one section per client with its projects nested under
 * it, then projects that belong to no client. Each section keeps the server's
 * order (most recently updated first).
 */
export function groupViews(views: ViewSummary[]): Group[] {
    const company: Group = { key: "company", title: "Company", views: [], projects: [] };
    const clients = new Map<string, Group>();
    const internal: Group = { key: "internal", title: "Projects without a client", views: [], projects: [] };
    const clientGroup = (id: string, label: string | null) => {
        let group = clients.get(id);
        if (!group) { group = { key: `customer:${id}`, title: label ?? "Client", views: [], projects: [] }; clients.set(id, group); }
        return group;
    };
    for (const view of views) {
        if (view.scopeType === "company") { company.views.push(view); continue; }
        if (view.scopeType === "customer" && view.scopeId) { clientGroup(view.scopeId, view.scopeLabel).views.push(view); continue; }
        const parent = view.customerId ? clientGroup(view.customerId, view.customerLabel) : internal;
        const key = `project:${view.scopeId}`;
        let project = parent.projects.find((p) => p.key === key);
        if (!project) { project = { key, title: view.scopeLabel ?? "Project", views: [] }; parent.projects.push(project); }
        project.views.push(view);
    }
    const sortedClients = [...clients.values()].sort((a, b) => a.title.localeCompare(b.title));
    return [company, ...sortedClients, internal].filter((g) => g.views.length > 0 || g.projects.length > 0);
}

function matches(view: ViewSummary, filter: FilterKey, query: string, userId: string): boolean {
    if (filter === "mine" && view.owner?.id !== userId) return false;
    if (filter === "shared" && !(view.visibility === "shared" && view.access === "full" && view.owner?.id !== userId)) return false;
    if (filter === "pinned" && !view.pinned) return false;
    if (!query) return true;
    return [view.title, view.description, view.scopeLabel, view.customerLabel, view.owner?.name, view.createdBy.name]
        .some((text) => text?.toLowerCase().includes(query));
}

export function ViewsBrowser({ views, showArchived, userId }: { views: ViewSummary[]; showArchived: boolean; userId: string }) {
    const now = useNowMs();
    const [filter, setFilter] = useState<FilterKey>("all");
    const [query, setQuery] = useState("");
    const shown = useMemo(() => views.filter((v) => matches(v, filter, query.trim().toLowerCase(), userId)), [views, filter, query, userId]);
    const groups = useMemo(() => groupViews(shown), [shown]);

    if (views.length === 0) {
        return showArchived ? (
            <div className="space-y-3">
                <EmptyState icon={IconArchive} title="No archived views" description="Views you archive move here, so Home and the list stay tidy." />
                <Link href="/views" className="text-sm text-primary hover:underline">Back to views</Link>
            </div>
        ) : <ViewsEmptyState />;
    }
    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div role="tablist" aria-label="Filter views" className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1">
                    {FILTERS.map((f) => (
                        <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}
                            className={cn("shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors",
                                filter === f.key ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
                            {f.label}
                        </button>
                    ))}
                </div>
                <label className="flex h-10 w-full items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm text-muted-foreground sm:w-72">
                    <IconSearch className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="sr-only">Search views</span>
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search views"
                        className="w-full min-w-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground" />
                </label>
            </div>

            {groups.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">No views match.</p>
            ) : groups.map((group) => (
                <section key={group.key} aria-labelledby={`views-${group.key}`} className="space-y-2">
                    <h2 id={`views-${group.key}`} className="px-1 text-sm font-semibold text-foreground">{group.title}</h2>
                    <div className="overflow-hidden rounded-2xl border border-border bg-card">
                        {group.views.length > 0 && (
                            <ul className="divide-y divide-border">{group.views.map((view) => <ViewRow key={view.id} view={view} now={now} showScope={false} />)}</ul>
                        )}
                        {group.projects.map((project, index) => (
                            <div key={project.key} className={cn((index > 0 || group.views.length > 0) && "border-t border-border")}>
                                <h3 className="bg-muted/40 px-4 py-1.5 text-xs font-medium text-muted-foreground">Project: {project.title}</h3>
                                <ul className="divide-y divide-border">{project.views.map((view) => <ViewRow key={view.id} view={view} now={now} showScope={false} />)}</ul>
                            </div>
                        ))}
                    </div>
                </section>
            ))}
            <Link href={showArchived ? "/views" : "/views?archived=1"} className="inline-block text-sm text-muted-foreground hover:text-foreground">
                {showArchived ? "Back to views" : "Show archived views"}
            </Link>
        </div>
    );
}

type ScopeOption = { id: string; name: string };

/** Members and up start a view (title, description, scope, who sees it); an agent fills in the panels. */
export function NewViewButton({ customers, projects }: { customers: ScopeOption[]; projects: ScopeOption[] }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [scope, setScope] = useState("company");
    const [visibility, setVisibility] = useState<"private" | "scope">("private");

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setBusy(true);
        try {
            const [scopeType, scopeId] = scope === "company" ? ["company", undefined] : scope.split(":");
            const res = await fetch("/api/views", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title, description, scopeType, scopeId, visibility }),
            });
            const data = await res.json().catch(() => ({})) as { view?: { id: string }; error?: string };
            if (!res.ok || !data.view) throw new Error(data.error || "Couldn't create the view");
            setOpen(false);
            router.push(`/views/${data.view.id}`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Couldn't create the view");
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Button size="sm" onClick={() => setOpen(true)}><IconPlus aria-hidden />New view</Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent>
                    <form onSubmit={submit} className="grid gap-4">
                        <DialogHeader>
                            <DialogTitle>New view</DialogTitle>
                            <DialogDescription>Name the page, then ask an agent to build its panels and keep them fresh.</DialogDescription>
                        </DialogHeader>
                        <div className="grid gap-1.5">
                            <Label htmlFor="view-title">Title</Label>
                            <Input id="view-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={VIEW_TITLE_MAX} required placeholder="Products this month" />
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="view-description">Description</Label>
                            <Textarea id="view-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={VIEW_DESCRIPTION_MAX} rows={3}
                                placeholder="What it shows, where the numbers come from, how often they refresh" />
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="view-scope">Where it lives</Label>
                            <select id="view-scope" value={scope} onChange={(e) => setScope(e.target.value)}
                                className="h-10 rounded-xl border border-border bg-card px-3 text-sm text-foreground">
                                <option value="company">Company</option>
                                {customers.length > 0 && (
                                    <optgroup label="Client">
                                        {customers.map((c) => <option key={c.id} value={`customer:${c.id}`}>{c.name}</option>)}
                                    </optgroup>
                                )}
                                {projects.length > 0 && (
                                    <optgroup label="Project">
                                        {projects.map((p) => <option key={p.id} value={`project:${p.id}`}>{p.name}</option>)}
                                    </optgroup>
                                )}
                            </select>
                        </div>
                        <fieldset className="grid gap-1.5">
                            <legend className="mb-1.5 text-sm font-medium text-foreground">Who can see it</legend>
                            <div className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-card p-1">
                                {([["private", "Only me"], ["scope", "Everyone in scope"]] as const).map(([value, label]) => (
                                    <label key={value} className={cn("cursor-pointer rounded-lg px-3 py-1.5 text-center text-sm transition-colors",
                                        visibility === value ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
                                        <input type="radio" name="view-visibility" value={value} checked={visibility === value} onChange={() => setVisibility(value)} className="sr-only" />
                                        {label}
                                    </label>
                                ))}
                            </div>
                            <p className="text-xs text-muted-foreground">You can share it with specific people later.</p>
                        </fieldset>
                        <DialogFooter>
                            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                            <Button type="submit" disabled={busy || !title.trim()}>{busy ? "Creating…" : "Create view"}</Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    );
}
