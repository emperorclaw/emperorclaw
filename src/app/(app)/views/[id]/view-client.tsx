"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
    IconArchive, IconArrowBackUp, IconChevronLeft, IconHistory, IconLock, IconPencil, IconPin, IconPinnedOff, IconRefresh, IconTrash, IconUserShare,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ViewGrid, formatAgo, useNowMs, type ViewPanelView } from "@/components/views/view-panels";
import { PersonChip, StaleNote, VisibilityBadge, scopeText } from "@/components/views/view-meta";
import { VIEW_DESCRIPTION_MAX, VIEW_TITLE_MAX, viewRefreshDirective } from "@/lib/view-spec";
import { refreshCadenceText } from "@/lib/view-access";
import { chatDraftKey } from "@/lib/chat-draft";
import type { ViewDetail } from "@/lib/views";
import { cn } from "@/lib/utils";

type Person = { type: string; id: string | null; name: string | null };
type Named = { id: string; name: string | null };
type VersionRow = { version: number; title: string; panelCount: number; author: Person; createdAt: string; current: boolean };

async function errorOf(res: Response, fallback: string): Promise<string> {
    const data = await res.json().catch(() => ({})) as { error?: string };
    return data.error || fallback;
}

const REFRESH_CHOICES: { value: number | null; label: string }[] = [
    { value: null, label: "No schedule" },
    { value: 15, label: "Every 15 minutes" },
    { value: 60, label: "Hourly" },
    { value: 360, label: "Every 6 hours" },
    { value: 1440, label: "Daily" },
    { value: 10080, label: "Weekly" },
];

export function ViewDetailClient({ view, canEdit, canManage, isOwner, agents, ownerAgentId, askAgentId, transferTo }: {
    view: ViewDetail;
    /** Member or above: rename, archive, revert, refresh. */
    canEdit: boolean;
    /** Owner/admin or the view's owner: transfer and delete. */
    canManage: boolean;
    /** The view's owner: decides who sees it. */
    isOwner: boolean;
    /** Agents this person may message (Refresh picker). */
    agents: { id: string; name: string }[];
    /** The maintaining agent, when this person may message it. */
    ownerAgentId: string | null;
    /** Where "Ask about this panel" goes: the maintainer, when that chat is private to this person (null hides the button). */
    askAgentId: string | null;
    transferTo: Named[];
}) {
    const router = useRouter();
    const now = useNowMs();
    const [busy, setBusy] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [refreshAgent, setRefreshAgent] = useState(ownerAgentId ?? agents[0]?.id ?? "");

    const send = async (url: string, init: RequestInit, done: string, key: string, fallback = "Couldn't update the view") => {
        setBusy(key);
        try {
            const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
            if (!res.ok) throw new Error(await errorOf(res, fallback));
            toast.success(done);
            router.refresh();
            return true;
        } catch (error) {
            toast.error(error instanceof Error ? error.message : fallback);
            return false;
        } finally {
            setBusy(null);
        }
    };
    const viewUrl = `/api/views/${encodeURIComponent(view.id)}`;
    const patch = (body: Record<string, unknown>, done: string, key: string) => send(viewUrl, { method: "PATCH", body: JSON.stringify(body) }, done, key);

    // The same path as a task Nudge: a chat directive to the agent.
    const refresh = async () => {
        if (!refreshAgent) return;
        setBusy("refresh");
        try {
            const res = await fetch("/api/chat", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ targetAgentId: refreshAgent, text: viewRefreshDirective(view) }),
            });
            if (!res.ok) throw new Error(await errorOf(res, "Couldn't reach the agent"));
            const name = agents.find((a) => a.id === refreshAgent)?.name ?? "The agent";
            toast.success(`Asked ${name} to refresh this view.`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Couldn't reach the agent");
        } finally {
            setBusy(null);
        }
    };

    // "Ask about this panel": the person's own chat with the maintaining agent,
    // with a draft quoting the view and panel (never sent for them).
    const ask = (panel: ViewPanelView) => {
        if (!askAgentId) return;
        const draft = `About the view "${view.title}" (/views/${view.id}), panel "${panel.title}": `;
        try { window.sessionStorage.setItem(chatDraftKey(askAgentId), draft); } catch { /* storage blocked: open the chat without a draft */ }
        router.push(`/messages?agent=${encodeURIComponent(askAgentId)}`);
    };

    const maintainer = view.createdBy.type === "agent" ? view.createdBy.name : null;
    const lastData = view.panels.reduce<string | null>((max, p) => (p.updatedAt && (!max || p.updatedAt > max) ? p.updatedAt : max), null);

    return (
        <>
            <div className="space-y-3">
                <Link href="/views" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                    <IconChevronLeft className="h-4 w-4" aria-hidden />Views
                </Link>
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 max-w-3xl space-y-1.5">
                        <p className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-400">{scopeText(view)}</p>
                        <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{view.title}</h1>
                        {view.description && <p className="whitespace-pre-line text-sm leading-6 text-muted-foreground">{view.description}</p>}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                            <VisibilityBadge view={view} />
                            {view.owner && <PersonChip name={view.owner.name} label="Owner:" />}
                        </div>
                        <p className="text-xs text-muted-foreground" suppressHydrationWarning>
                            {maintainer ? `Kept up to date by ${maintainer}` : view.createdBy.name ? `Created by ${view.createdBy.name}` : "Created by an agent"}
                            {view.refreshEveryMinutes ? ` ${refreshCadenceText(view.refreshEveryMinutes)}` : ""}
                            {" · "}{lastData ? `values updated ${formatAgo(lastData, now)}` : "no values yet"}
                            {" · "}version {view.version}
                        </p>
                        <StaleNote lastAt={lastData} since={view.createdAt} refreshEveryMinutes={view.refreshEveryMinutes} now={now} />
                    </div>
                    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                        {canEdit && !view.archived && (
                            <div className="flex items-center gap-1.5">
                                {!ownerAgentId && agents.length > 0 && (
                                    <select aria-label="Agent to ask for a refresh" value={refreshAgent} onChange={(e) => setRefreshAgent(e.target.value)}
                                        className="h-8 max-w-[11rem] rounded-lg border border-border bg-card px-2 text-sm text-foreground">
                                        {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                                    </select>
                                )}
                                <Button size="sm" onClick={refresh} disabled={!refreshAgent || busy === "refresh"}
                                    title={ownerAgentId ? `Ask ${maintainer ?? "the maintaining agent"} to update every panel now` : "Ask an agent to update every panel now"}>
                                    <IconRefresh className={busy === "refresh" ? "animate-spin" : undefined} aria-hidden />Refresh
                                </Button>
                            </div>
                        )}
                        {!view.archived && (
                            <Button size="sm" variant="outline" disabled={busy === "pin"}
                                onClick={() => send(`${viewUrl}/pin`, { method: view.pinned ? "DELETE" : "PUT" }, view.pinned ? "Removed from your Home" : "Pinned to your Home", "pin")}>
                                {view.pinned ? <IconPinnedOff aria-hidden /> : <IconPin aria-hidden />}
                                {view.pinned ? "Unpin from my Home" : "Pin to my Home"}
                            </Button>
                        )}
                        {canEdit && !view.archived && (
                            <Button size="sm" variant="outline" onClick={() => setEditing(true)}><IconPencil aria-hidden />Edit</Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => setHistoryOpen(true)}><IconHistory aria-hidden />History</Button>
                        {canEdit && (view.archived ? (
                            <Button size="sm" variant="outline" disabled={busy === "archive"} onClick={() => patch({ archived: false }, "View restored", "archive")}>
                                <IconArrowBackUp aria-hidden />Restore
                            </Button>
                        ) : (
                            <Button size="sm" variant="ghost" disabled={busy === "archive"}
                                onClick={async () => {
                                    if (!window.confirm(`Archive "${view.title}"? It leaves the Views list and everyone's Home; you can restore it later.`)) return;
                                    if (await patch({ archived: true }, "View archived", "archive")) router.push("/views");
                                }}>
                                <IconArchive aria-hidden />Archive
                            </Button>
                        ))}
                        {canManage && <ManageButtons view={view} transferTo={transferTo} />}
                    </div>
                </div>
                {isOwner && <VisibilityControl view={view} />}
                {view.archived && (
                    <p className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground">This view is archived. Restore it to pin it or ask for a refresh.</p>
                )}
            </div>

            <ViewGrid
                panels={view.panels}
                refreshEveryMinutes={view.refreshEveryMinutes}
                since={view.createdAt}
                onAsk={askAgentId && !view.archived ? ask : undefined}
                emptyHint={<>No panels yet. Ask an agent: &ldquo;Build the panels for the view &lsquo;{view.title}&rsquo; and keep it fresh.&rdquo;</>}
            />

            {editing && <EditDialog view={view} onClose={() => setEditing(false)} onSave={(body) => patch(body, "View updated", "edit")} />}
            <HistoryDrawer viewId={view.id} open={historyOpen} onOpenChange={setHistoryOpen} canRevert={canEdit && !view.archived} onReverted={() => router.refresh()} />
        </>
    );
}

/**
 * An owner/admin outside a private or shared view: who owns it, who keeps it
 * up to date, where it lives and when it changed. Nothing of its content.
 */
export function ViewMetadataClient({ view, transferTo }: { view: ViewDetail; transferTo: Named[] }) {
    const now = useNowMs();
    const maintainer = view.createdBy.type === "agent" ? view.createdBy.name : null;
    return (
        <div className="space-y-4">
            <Link href="/views" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <IconChevronLeft className="h-4 w-4" aria-hidden />Views
            </Link>
            <div className="space-y-1.5">
                <p className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-400">{scopeText(view)}</p>
                <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{view.title}</h1>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <VisibilityBadge view={view} />
                    {view.owner ? <PersonChip name={view.owner.name} label="Owner:" /> : <span className="text-xs text-muted-foreground">No owner</span>}
                </div>
            </div>
            <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                <div className="flex items-start gap-3">
                    <IconLock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium text-foreground">
                            Only its owner{view.visibility === "shared" ? " and the people it is shared with" : ""} can open this view.
                        </p>
                        <p className="text-sm text-muted-foreground">
                            As an admin you see who owns it and who keeps it up to date, not its panels or history. You can hand it to someone else or delete it.
                        </p>
                    </div>
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                    <div><dt className="text-xs text-muted-foreground">Kept up to date by</dt><dd className="text-foreground">{maintainer ?? "No agent"}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Where it lives</dt><dd className="text-foreground">{scopeText(view)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Last changed</dt><dd className="text-foreground" suppressHydrationWarning>{formatAgo(view.updatedAt, now)}</dd></div>
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                    <ManageButtons view={view} transferTo={transferTo} afterDelete="/views" />
                </div>
            </section>
        </div>
    );
}

/** Transfer ownership and delete: owners/admins (with or without access to the content) and the view's owner. */
function ManageButtons({ view, transferTo, afterDelete = "/views" }: { view: ViewDetail; transferTo: Named[]; afterDelete?: string }) {
    const router = useRouter();
    const [transferOpen, setTransferOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const remove = async () => {
        if (!window.confirm(`Delete "${view.title}" for good? Its panels, values and history are removed for everyone. This cannot be undone.`)) return;
        setDeleting(true);
        try {
            const res = await fetch(`/api/views/${encodeURIComponent(view.id)}`, { method: "DELETE" });
            if (!res.ok) throw new Error(await errorOf(res, "Couldn't delete the view"));
            toast.success("View deleted");
            router.push(afterDelete);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Couldn't delete the view");
            setDeleting(false);
        }
    };
    return (
        <>
            <Button size="sm" variant="outline" onClick={() => setTransferOpen(true)}><IconUserShare aria-hidden />Transfer</Button>
            <Button size="sm" variant="ghost" disabled={deleting} onClick={remove} className="text-destructive hover:text-destructive"><IconTrash aria-hidden />Delete</Button>
            {transferOpen && <TransferDialog view={view} people={transferTo} onClose={() => setTransferOpen(false)} />}
        </>
    );
}

function TransferDialog({ view, people, onClose }: { view: ViewDetail; people: Named[]; onClose: () => void }) {
    const router = useRouter();
    // The server already leaves out the owner and, when it cannot be opened, the caller.
    const candidates = people.filter((p) => p.id !== view.owner?.id);
    const [to, setTo] = useState(candidates[0]?.id ?? "");
    const [saving, setSaving] = useState(false);
    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent>
                <form className="grid gap-4" onSubmit={async (event) => {
                    event.preventDefault();
                    setSaving(true);
                    try {
                        const res = await fetch(`/api/views/${encodeURIComponent(view.id)}/owner`, {
                            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerUserId: to }),
                        });
                        if (!res.ok) throw new Error(await errorOf(res, "Couldn't transfer the view"));
                        toast.success("Ownership transferred");
                        onClose();
                        router.refresh();
                    } catch (error) {
                        toast.error(error instanceof Error ? error.message : "Couldn't transfer the view");
                    } finally {
                        setSaving(false);
                    }
                }}>
                    <DialogHeader>
                        <DialogTitle>Transfer ownership</DialogTitle>
                        <DialogDescription>The new owner decides who sees &ldquo;{view.title}&rdquo;. They must be able to see its scope.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-1.5">
                        <Label htmlFor="transfer-to">New owner</Label>
                        <select id="transfer-to" value={to} onChange={(e) => setTo(e.target.value)} required
                            className="h-10 rounded-xl border border-border bg-card px-3 text-sm text-foreground">
                            {candidates.map((p) => <option key={p.id} value={p.id}>{p.name ?? "Someone"}</option>)}
                        </select>
                    </div>
                    {candidates.length === 0 && <p className="text-sm text-muted-foreground">Nobody else can see this view&rsquo;s scope.</p>}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                        <Button type="submit" disabled={saving || !to}>{saving ? "Transferring…" : "Transfer"}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

const VISIBILITY_OPTIONS = [
    { value: "private", label: "Private" },
    { value: "shared", label: "Shared" },
    { value: "scope", label: "Everyone in scope" },
] as const;

/** The owner's control: Private / Shared (with a people picker) / Everyone in scope. */
function VisibilityControl({ view }: { view: ViewDetail }) {
    const router = useRouter();
    const [saving, setSaving] = useState(false);
    const [picking, setPicking] = useState(false);
    const save = async (visibility: string, shareUserIds?: string[]) => {
        setSaving(true);
        try {
            const res = await fetch(`/api/views/${encodeURIComponent(view.id)}/access`, {
                method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visibility, shareUserIds }),
            });
            if (!res.ok) throw new Error(await errorOf(res, "Couldn't change who sees this view"));
            toast.success(visibility === "private" ? "Only you can see this view" : visibility === "shared" ? "Sharing updated" : "Everyone in scope can see this view");
            router.refresh();
            return true;
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Couldn't change who sees this view");
            return false;
        } finally {
            setSaving(false);
        }
    };
    const scopeWord = view.scopeType === "company" ? "the company" : view.scopeType === "customer" ? "this client" : "this project";
    return (
        <section aria-labelledby="view-visibility-heading" className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
                <h2 id="view-visibility-heading" className="text-sm font-medium text-foreground">Who can see it</h2>
                <p className="text-xs text-muted-foreground">
                    {view.visibility === "private" && "Only you (and the agent that keeps it up to date)."}
                    {view.visibility === "shared" && <>You and {view.sharedWith && view.sharedWith.length > 0 ? view.sharedWith.map((p) => p.name ?? "someone").join(", ") : "the people you picked"}.</>}
                    {view.visibility === "scope" && `Everyone who can see ${scopeWord}.`}
                </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <div role="radiogroup" aria-label="Who can see it" className="grid grid-cols-3 gap-1 rounded-xl border border-border bg-background p-1">
                    {VISIBILITY_OPTIONS.map((option) => (
                        <button key={option.value} type="button" role="radio" aria-checked={view.visibility === option.value} disabled={saving}
                            onClick={() => option.value === "shared" ? setPicking(true) : view.visibility !== option.value && void save(option.value)}
                            className={cn("whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs transition-colors sm:text-sm",
                                view.visibility === option.value ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>
            {picking && <SharePicker view={view} onClose={() => setPicking(false)} onSave={(ids) => save("shared", ids)} />}
        </section>
    );
}

function SharePicker({ view, onClose, onSave }: { view: ViewDetail; onClose: () => void; onSave: (ids: string[]) => Promise<boolean> }) {
    const [people, setPeople] = useState<Named[] | null>(null);
    const [chosen, setChosen] = useState<Set<string>>(() => new Set((view.sharedWith ?? []).map((p) => p.id)));
    const [filter, setFilter] = useState("");
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        let alive = true;
        fetch(`/api/views/${encodeURIComponent(view.id)}/access`).then(async (res) => {
            if (!res.ok) throw new Error(await errorOf(res, "Couldn't load people"));
            const data = await res.json() as { people: Named[] };
            if (alive) setPeople(data.people);
        }).catch((error) => { toast.error(error instanceof Error ? error.message : "Couldn't load people"); if (alive) setPeople([]); });
        return () => { alive = false; };
    }, [view.id]);
    const shown = (people ?? []).filter((p) => (p.name ?? "").toLowerCase().includes(filter.trim().toLowerCase()));
    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent>
                <form className="grid gap-4" onSubmit={async (event) => {
                    event.preventDefault();
                    setSaving(true);
                    const ok = await onSave([...chosen]);
                    setSaving(false);
                    if (ok) onClose();
                }}>
                    <DialogHeader>
                        <DialogTitle>Share with people</DialogTitle>
                        <DialogDescription>Only members who can see this view&rsquo;s scope are listed.</DialogDescription>
                    </DialogHeader>
                    <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a person" aria-label="Find a person" />
                    <div className="max-h-72 overflow-y-auto rounded-xl border border-border">
                        {people === null && <p className="p-3 text-sm text-muted-foreground">Loading…</p>}
                        {people !== null && shown.length === 0 && <p className="p-3 text-sm text-muted-foreground">Nobody else can see this scope.</p>}
                        <ul className="divide-y divide-border">
                            {shown.map((person) => (
                                <li key={person.id}>
                                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-accent/60">
                                        <input type="checkbox" checked={chosen.has(person.id)} className="h-4 w-4 accent-current"
                                            onChange={(e) => setChosen((prev) => {
                                                const next = new Set(prev);
                                                if (e.target.checked) next.add(person.id); else next.delete(person.id);
                                                return next;
                                            })} />
                                        <PersonChip name={person.name} className="text-sm text-foreground" />
                                    </label>
                                </li>
                            ))}
                        </ul>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                        <Button type="submit" disabled={saving || chosen.size === 0}>{saving ? "Saving…" : `Share with ${chosen.size}`}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function EditDialog({ view, onClose, onSave }: {
    view: ViewDetail;
    onClose: () => void;
    onSave: (body: { title: string; description: string; refreshEveryMinutes: number | null }) => Promise<boolean>;
}) {
    const [title, setTitle] = useState(view.title);
    const [description, setDescription] = useState(view.description ?? "");
    const [refresh, setRefresh] = useState<number | null>(view.refreshEveryMinutes);
    const [saving, setSaving] = useState(false);
    const choices = REFRESH_CHOICES.some((c) => c.value === refresh) ? REFRESH_CHOICES : [...REFRESH_CHOICES, { value: refresh, label: refreshCadenceText(refresh ?? 0) }];
    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent>
                <form className="grid gap-4" onSubmit={async (event) => {
                    event.preventDefault();
                    setSaving(true);
                    const ok = await onSave({ title, description, refreshEveryMinutes: refresh });
                    setSaving(false);
                    if (ok) onClose();
                }}>
                    <DialogHeader>
                        <DialogTitle>Edit view</DialogTitle>
                        <DialogDescription>The panels are the agent&rsquo;s job; ask it for layout changes.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-1.5">
                        <Label htmlFor="edit-view-title">Title</Label>
                        <Input id="edit-view-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={VIEW_TITLE_MAX} required />
                    </div>
                    <div className="grid gap-1.5">
                        <Label htmlFor="edit-view-description">Description</Label>
                        <Textarea id="edit-view-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={VIEW_DESCRIPTION_MAX} rows={4} />
                    </div>
                    <div className="grid gap-1.5">
                        <Label htmlFor="edit-view-refresh">Expected refresh</Label>
                        <select id="edit-view-refresh" value={refresh ?? ""} onChange={(e) => setRefresh(e.target.value ? Number(e.target.value) : null)}
                            className="h-10 rounded-xl border border-border bg-card px-3 text-sm text-foreground">
                            {choices.map((c) => <option key={c.value ?? "none"} value={c.value ?? ""}>{c.label}</option>)}
                        </select>
                        <p className="text-xs text-muted-foreground">The view shows &ldquo;Overdue&rdquo; when its values are older than one and a half times this.</p>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                        <Button type="submit" disabled={saving || !title.trim()}>{saving ? "Saving…" : "Save"}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Layout history, newest first, with revert (members and up). Loaded when opened. */
function HistoryDrawer({ viewId, open, onOpenChange, canRevert, onReverted }: {
    viewId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    canRevert: boolean;
    onReverted: () => void;
}) {
    const now = useNowMs();
    const [versions, setVersions] = useState<VersionRow[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [reverting, setReverting] = useState<number | null>(null);

    const load = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/views/${encodeURIComponent(viewId)}/versions`);
            if (!res.ok) throw new Error(await errorOf(res, "Couldn't load the history"));
            setVersions(((await res.json()) as { versions: VersionRow[] }).versions);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Couldn't load the history");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (open) void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, viewId]);

    const revert = async (version: number) => {
        setReverting(version);
        try {
            const res = await fetch(`/api/views/${encodeURIComponent(viewId)}/revert`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version }),
            });
            if (!res.ok) throw new Error(await errorOf(res, "Couldn't revert"));
            toast.success(`Reverted to version ${version}`);
            onReverted();
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Couldn't revert");
        } finally {
            setReverting(null);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="top-0 right-0 left-auto h-dvh max-h-dvh w-full max-w-md translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none border-y-0 border-r-0 sm:max-w-md data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100">
                <DialogHeader>
                    <DialogTitle>Version history</DialogTitle>
                    <DialogDescription>Each layout or title change is a version. Reverting brings an old layout back as a new version; panel values stay with the agent&rsquo;s next refresh.</DialogDescription>
                </DialogHeader>
                {loading && !versions && <p className="text-sm text-muted-foreground">Loading…</p>}
                {versions && versions.length === 0 && <p className="text-sm text-muted-foreground">No versions yet.</p>}
                {versions && versions.length > 0 && (
                    <ol className="divide-y divide-border rounded-xl border border-border">
                        {versions.map((v) => (
                            <li key={v.version} className="flex items-center justify-between gap-3 px-3 py-2.5">
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-foreground">
                                        Version {v.version}{v.current && <span className="ml-2 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Current</span>}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {v.title} · {v.panelCount} panel{v.panelCount === 1 ? "" : "s"} · {v.author.name ?? (v.author.type === "agent" ? "an agent" : "someone")} · {formatAgo(v.createdAt, now)}
                                    </p>
                                </div>
                                {canRevert && !v.current && (
                                    <Button size="xs" variant="outline" disabled={reverting !== null} onClick={() => revert(v.version)}>
                                        {reverting === v.version ? "Reverting…" : "Revert"}
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ol>
                )}
            </DialogContent>
        </Dialog>
    );
}
