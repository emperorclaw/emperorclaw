"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { IconArchive, IconLayoutDashboard, IconMessageCircle, IconPin, IconPlus } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { formatAgo, useNowMs } from "@/components/views/view-panels";
import type { ViewSummary } from "@/lib/views";
import { VIEW_DESCRIPTION_MAX, VIEW_TITLE_MAX } from "@/lib/view-spec";

const EXAMPLE_ASKS = [
    "Build me a view of this month's e-shop products",
    "Build me a view of our finances for the last 7 days",
    "Build me a view of open leads by stage, refreshed daily",
];

export function scopeText(view: { scopeType: string; scopeLabel: string | null }): string {
    if (view.scopeType === "company") return "Company";
    const noun = view.scopeType === "customer" ? "Client" : "Project";
    return view.scopeLabel ? `${noun}: ${view.scopeLabel}` : noun;
}

/** The empty state teaches the one way views get built: ask an agent. */
export function ViewsEmptyState() {
    return (
        <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-10 text-center">
            <IconLayoutDashboard className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
            <h2 className="mt-3 text-base font-semibold text-foreground">No views yet</h2>
            <p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">
                Views are dashboards your agents build and keep fresh. Ask an agent: &ldquo;Build me a view of &hellip;&rdquo; and it creates the page, fills in the numbers and refreshes them on a schedule.
            </p>
            <ul className="mx-auto mt-4 flex max-w-xl flex-col gap-2 text-left text-sm">
                {EXAMPLE_ASKS.map((ask) => (
                    <li key={ask} className="rounded-xl border border-border bg-background px-3 py-2 text-foreground">&ldquo;{ask}&rdquo;</li>
                ))}
            </ul>
            <Link href="/messages" className="mt-4 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-foreground hover:bg-accent">
                <IconMessageCircle className="h-4 w-4" aria-hidden />Open chat
            </Link>
        </div>
    );
}

export function ViewsList({ views, showArchived }: { views: ViewSummary[]; showArchived: boolean }) {
    const now = useNowMs();
    if (views.length === 0) {
        return showArchived ? (
            <div className="space-y-3">
                <p className="rounded-2xl border border-dashed border-border bg-card px-5 py-8 text-center text-sm text-muted-foreground">No archived views.</p>
                <Link href="/views" className="text-sm text-primary hover:underline">Back to views</Link>
            </div>
        ) : <ViewsEmptyState />;
    }
    return (
        <div className="space-y-3">
            <div className="overflow-hidden rounded-2xl border border-border bg-card">
                <div className="hidden grid-cols-[minmax(0,1fr)_180px_80px_150px_70px] gap-3 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
                    <span>Title</span><span>Scope</span><span className="text-right">Panels</span><span>Last updated</span><span className="text-center">Home</span>
                </div>
                <ul className="divide-y divide-border">
                    {views.map((view) => {
                        const updated = view.dataUpdatedAt && view.dataUpdatedAt > view.updatedAt ? view.dataUpdatedAt : view.updatedAt;
                        return (
                            <li key={view.id}>
                                <Link href={`/views/${view.id}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 hover:bg-accent/60 md:grid md:grid-cols-[minmax(0,1fr)_180px_80px_150px_70px] md:items-center md:gap-3">
                                    <span className="w-full min-w-0 md:w-auto">
                                        <span className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                                            {view.archived && <IconArchive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Archived" />}
                                            {view.title}
                                        </span>
                                        {view.description && <span className="block truncate text-xs text-muted-foreground">{view.description}</span>}
                                    </span>
                                    <span className="truncate text-xs text-muted-foreground md:text-sm">{scopeText(view)}</span>
                                    <span className="text-xs text-muted-foreground md:text-right md:text-sm md:tabular-nums">
                                        <span className="md:hidden">{view.panelCount} panel{view.panelCount === 1 ? "" : "s"}</span>
                                        <span className="hidden md:inline">{view.panelCount}</span>
                                    </span>
                                    <span className="truncate text-xs text-muted-foreground md:text-sm" suppressHydrationWarning>
                                        <span className="md:hidden">Updated </span>{formatAgo(updated, now)}{view.createdBy.name ? ` · ${view.createdBy.name}` : ""}
                                    </span>
                                    <span className="text-xs text-muted-foreground md:flex md:justify-center">
                                        {view.pinnedToHome
                                            ? <span className="inline-flex items-center gap-1 text-primary"><IconPin className="h-4 w-4" aria-hidden /><span className="md:sr-only">Pinned to Home</span></span>
                                            : <span className="hidden md:inline" aria-label="Not pinned">—</span>}
                                    </span>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            </div>
            <Link href={showArchived ? "/views" : "/views?archived=1"} className="inline-block text-sm text-muted-foreground hover:text-foreground">
                {showArchived ? "Back to views" : "Show archived views"}
            </Link>
        </div>
    );
}

type ScopeOption = { id: string; name: string };

/** Members and up start a view (title, description, scope); an agent fills in the panels. */
export function NewViewButton({ customers, projects }: { customers: ScopeOption[]; projects: ScopeOption[] }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [scope, setScope] = useState("company");

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setBusy(true);
        try {
            const [scopeType, scopeId] = scope === "company" ? ["company", undefined] : scope.split(":");
            const res = await fetch("/api/views", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title, description, scopeType, scopeId }),
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
                            <Label htmlFor="view-scope">Who can see it</Label>
                            <select id="view-scope" value={scope} onChange={(e) => setScope(e.target.value)}
                                className="h-10 rounded-xl border border-border bg-card px-3 text-sm text-foreground">
                                <option value="company">Everyone in the company</option>
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
