"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
    IconArchive, IconArrowBackUp, IconChevronLeft, IconHistory, IconPencil, IconPin, IconPinnedOff, IconRefresh,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ViewGrid, formatAgo, useNowMs, type ViewPanelView } from "@/components/views/view-panels";
import { VIEW_DESCRIPTION_MAX, VIEW_TITLE_MAX, viewRefreshDirective } from "@/lib/view-spec";
import { scopeText } from "../views-client";

type Person = { type: string; id: string | null; name: string | null };

export type ViewDetailData = {
    id: string;
    title: string;
    description: string | null;
    scopeType: string;
    scopeId: string | null;
    scopeLabel: string | null;
    version: number;
    pinnedToHome: boolean;
    archived: boolean;
    createdBy: Person;
    updatedBy: Person;
    updatedAt: string;
    panels: ViewPanelView[];
};

type VersionRow = { version: number; title: string; panelCount: number; author: Person; createdAt: string; current: boolean };

async function errorOf(res: Response, fallback: string): Promise<string> {
    const data = await res.json().catch(() => ({})) as { error?: string };
    return data.error || fallback;
}

export function ViewDetailClient({ view, canEdit, agents, ownerAgentId }: {
    view: ViewDetailData;
    canEdit: boolean;
    /** Agents this person may message (Refresh picker). */
    agents: { id: string; name: string }[];
    /** The creating agent, when this person may message it. */
    ownerAgentId: string | null;
}) {
    const router = useRouter();
    const now = useNowMs();
    const [busy, setBusy] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [refreshAgent, setRefreshAgent] = useState(ownerAgentId ?? agents[0]?.id ?? "");

    const patch = async (body: Record<string, unknown>, done: string, key: string) => {
        setBusy(key);
        try {
            const res = await fetch(`/api/views/${encodeURIComponent(view.id)}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(await errorOf(res, "Couldn't update the view"));
            toast.success(done);
            router.refresh();
            return true;
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Couldn't update the view");
            return false;
        } finally {
            setBusy(null);
        }
    };

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

    const owner = view.createdBy.type === "agent" ? view.createdBy.name : null;
    const lastData = view.panels.reduce<string | null>((max, p) => (p.updatedAt && (!max || p.updatedAt > max) ? p.updatedAt : max), null);

    return (
        <>
            <div className="space-y-3">
                <Link href="/views" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                    <IconChevronLeft className="h-4 w-4" aria-hidden />Views
                </Link>
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 max-w-3xl space-y-1">
                        <p className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-400">{scopeText(view)}</p>
                        <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{view.title}</h1>
                        {view.description && <p className="whitespace-pre-line text-sm leading-6 text-muted-foreground">{view.description}</p>}
                        <p className="text-xs text-muted-foreground" suppressHydrationWarning>
                            {owner ? `Kept up to date by ${owner}` : view.createdBy.name ? `Created by ${view.createdBy.name}` : "Created by an agent"}
                            {" · "}{lastData ? `values updated ${formatAgo(lastData, now)}` : "no values yet"}
                            {" · "}version {view.version}
                        </p>
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
                                    title={ownerAgentId ? `Ask ${owner ?? "the owning agent"} to update every panel now` : "Ask an agent to update every panel now"}>
                                    <IconRefresh className={busy === "refresh" ? "animate-spin" : undefined} aria-hidden />Refresh
                                </Button>
                            </div>
                        )}
                        {canEdit && !view.archived && (
                            <Button size="sm" variant="outline" disabled={busy === "pin"}
                                onClick={() => patch({ pinnedToHome: !view.pinnedToHome }, view.pinnedToHome ? "Removed from Home" : "Pinned to Home", "pin")}>
                                {view.pinnedToHome ? <IconPinnedOff aria-hidden /> : <IconPin aria-hidden />}
                                {view.pinnedToHome ? "Unpin from Home" : "Pin to Home"}
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
                                    if (!window.confirm(`Archive "${view.title}"? It leaves the Views list and Home; you can restore it later.`)) return;
                                    if (await patch({ archived: true }, "View archived", "archive")) router.push("/views");
                                }}>
                                <IconArchive aria-hidden />Archive
                            </Button>
                        ))}
                    </div>
                </div>
                {view.archived && (
                    <p className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground">This view is archived. Restore it to pin it or ask for a refresh.</p>
                )}
            </div>

            <ViewGrid
                panels={view.panels}
                emptyHint={<>No panels yet. Ask an agent: &ldquo;Build the panels for the view &lsquo;{view.title}&rsquo; and keep it fresh.&rdquo;</>}
            />

            {editing && <EditDialog view={view} onClose={() => setEditing(false)} onSave={(body) => patch(body, "View updated", "edit")} />}
            <HistoryDrawer viewId={view.id} open={historyOpen} onOpenChange={setHistoryOpen} canRevert={canEdit && !view.archived} onReverted={() => router.refresh()} />
        </>
    );
}

function EditDialog({ view, onClose, onSave }: {
    view: ViewDetailData;
    onClose: () => void;
    onSave: (body: { title: string; description: string }) => Promise<boolean>;
}) {
    const [title, setTitle] = useState(view.title);
    const [description, setDescription] = useState(view.description ?? "");
    const [saving, setSaving] = useState(false);
    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent>
                <form className="grid gap-4" onSubmit={async (event) => {
                    event.preventDefault();
                    setSaving(true);
                    const ok = await onSave({ title, description });
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
