"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
    IconArchive, IconArrowBackUp, IconChevronLeft, IconHistory, IconLock, IconPencil, IconPin, IconPinnedOff, IconRefresh, IconTrash, IconUserShare,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ViewGrid, useFormatAgo, useNowMs, type ViewPanelView } from "@/components/views/view-panels";
import { PersonChip, StaleNote, VisibilityBadge, useRefreshCadenceText, useScopeText } from "@/components/views/view-meta";
import { VIEW_DESCRIPTION_MAX, VIEW_TITLE_MAX, viewRefreshDirective } from "@/lib/view-spec";
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

/** Refresh intervals offered in Edit, labelled by views.detail.refreshChoices.<key>. */
const REFRESH_CHOICES = [
    { value: null, key: "none" },
    { value: 15, key: "every15Minutes" },
    { value: 60, key: "hourly" },
    { value: 360, key: "every6Hours" },
    { value: 1440, key: "daily" },
    { value: 10080, key: "weekly" },
] as const;

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
    const t = useTranslations("views.detail");
    const tc = useTranslations("common");
    const formatAgo = useFormatAgo();
    const scopeText = useScopeText();
    const cadence = useRefreshCadenceText();
    const router = useRouter();
    const now = useNowMs();
    const [busy, setBusy] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [refreshAgent, setRefreshAgent] = useState(ownerAgentId ?? agents[0]?.id ?? "");

    const send = async (url: string, init: RequestInit, done: string, key: string, fallback = t("updateFailed")) => {
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
            if (!res.ok) throw new Error(await errorOf(res, t("reachFailed")));
            const name = agents.find((a) => a.id === refreshAgent)?.name ?? t("theAgent");
            toast.success(t("refreshAsked", { name }));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("reachFailed"));
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
                    <IconChevronLeft className="h-4 w-4" aria-hidden />{t("back")}
                </Link>
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 max-w-3xl space-y-1.5">
                        <p className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-400">{scopeText(view)}</p>
                        <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{view.title}</h1>
                        {view.description && <p className="whitespace-pre-line text-sm leading-6 text-muted-foreground">{view.description}</p>}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                            <VisibilityBadge view={view} />
                            {view.owner && <PersonChip name={view.owner.name} label={t("ownerLabel")} />}
                        </div>
                        <p className="text-xs text-muted-foreground" suppressHydrationWarning>
                            {maintainer ? t("keptUpBy", { name: maintainer }) : view.createdBy.name ? t("createdBy", { name: view.createdBy.name }) : t("createdByAgent")}
                            {view.refreshEveryMinutes ? ` ${cadence(view.refreshEveryMinutes)}` : ""}
                            {" · "}{lastData ? t("valuesUpdated", { ago: formatAgo(lastData, now) }) : t("noValuesYet")}
                            {" · "}{t("version", { version: view.version })}
                        </p>
                        <StaleNote lastAt={lastData} since={view.createdAt} refreshEveryMinutes={view.refreshEveryMinutes} now={now} />
                    </div>
                    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                        {canEdit && !view.archived && (
                            <div className="flex items-center gap-1.5">
                                {!ownerAgentId && agents.length > 0 && (
                                    <select aria-label={t("refreshAgent")} value={refreshAgent} onChange={(e) => setRefreshAgent(e.target.value)}
                                        className="h-8 max-w-[11rem] rounded-lg border border-border bg-card px-2 text-sm text-foreground">
                                        {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                                    </select>
                                )}
                                <Button size="sm" onClick={refresh} disabled={!refreshAgent || busy === "refresh"}
                                    title={ownerAgentId ? t("refreshTitle", { name: maintainer ?? t("theMaintainingAgent") }) : t("refreshTitleAny")}>
                                    <IconRefresh className={busy === "refresh" ? "animate-spin" : undefined} aria-hidden />{t("refresh")}
                                </Button>
                            </div>
                        )}
                        {!view.archived && (
                            <Button size="sm" variant="outline" disabled={busy === "pin"}
                                onClick={() => send(`${viewUrl}/pin`, { method: view.pinned ? "DELETE" : "PUT" }, view.pinned ? t("unpinned") : t("pinned"), "pin")}>
                                {view.pinned ? <IconPinnedOff aria-hidden /> : <IconPin aria-hidden />}
                                {view.pinned ? t("unpin") : t("pin")}
                            </Button>
                        )}
                        {canEdit && !view.archived && (
                            <Button size="sm" variant="outline" onClick={() => setEditing(true)}><IconPencil aria-hidden />{tc("edit")}</Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => setHistoryOpen(true)}><IconHistory aria-hidden />{t("history")}</Button>
                        {canEdit && (view.archived ? (
                            <Button size="sm" variant="outline" disabled={busy === "archive"} onClick={() => patch({ archived: false }, t("restored"), "archive")}>
                                <IconArrowBackUp aria-hidden />{t("restore")}
                            </Button>
                        ) : (
                            <Button size="sm" variant="ghost" disabled={busy === "archive"}
                                onClick={async () => {
                                    if (!window.confirm(t("archiveConfirm", { title: view.title }))) return;
                                    if (await patch({ archived: true }, t("archived"), "archive")) router.push("/views");
                                }}>
                                <IconArchive aria-hidden />{t("archive")}
                            </Button>
                        ))}
                        {canManage && <ManageButtons view={view} transferTo={transferTo} />}
                    </div>
                </div>
                {isOwner && <VisibilityControl view={view} />}
                {view.archived && (
                    <p className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground">{t("archivedNote")}</p>
                )}
            </div>

            <ViewGrid
                panels={view.panels}
                refreshEveryMinutes={view.refreshEveryMinutes}
                since={view.createdAt}
                onAsk={askAgentId && !view.archived ? ask : undefined}
                emptyHint={t("emptyPanels", { title: view.title })}
            />

            {editing && <EditDialog view={view} onClose={() => setEditing(false)} onSave={(body) => patch(body, t("updated"), "edit")} />}
            <HistoryDrawer viewId={view.id} open={historyOpen} onOpenChange={setHistoryOpen} canRevert={canEdit && !view.archived} onReverted={() => router.refresh()} />
        </>
    );
}

/**
 * An owner/admin outside a private or shared view: who owns it, who keeps it
 * up to date, where it lives and when it changed. Nothing of its content.
 */
export function ViewMetadataClient({ view, transferTo }: { view: ViewDetail; transferTo: Named[] }) {
    const t = useTranslations("views.detail");
    const formatAgo = useFormatAgo();
    const scopeText = useScopeText();
    const now = useNowMs();
    const maintainer = view.createdBy.type === "agent" ? view.createdBy.name : null;
    return (
        <div className="space-y-4">
            <Link href="/views" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <IconChevronLeft className="h-4 w-4" aria-hidden />{t("back")}
            </Link>
            <div className="space-y-1.5">
                <p className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-400">{scopeText(view)}</p>
                <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{view.title}</h1>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <VisibilityBadge view={view} />
                    {view.owner ? <PersonChip name={view.owner.name} label={t("ownerLabel")} /> : <span className="text-xs text-muted-foreground">{t("noOwner")}</span>}
                </div>
            </div>
            <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                <div className="flex items-start gap-3">
                    <IconLock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium text-foreground">
                            {view.visibility === "shared" ? t("metadataOwnerShared") : t("metadataOwnerOnly")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                            {t("metadataAdminNote")}
                        </p>
                    </div>
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                    <div><dt className="text-xs text-muted-foreground">{t("keptUpByLabel")}</dt><dd className="text-foreground">{maintainer ?? t("noAgent")}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t("whereItLives")}</dt><dd className="text-foreground">{scopeText(view)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t("lastChanged")}</dt><dd className="text-foreground" suppressHydrationWarning>{formatAgo(view.updatedAt, now)}</dd></div>
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
    const t = useTranslations("views.detail");
    const tc = useTranslations("common");
    const router = useRouter();
    const [transferOpen, setTransferOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const remove = async () => {
        if (!window.confirm(t("deleteConfirm", { title: view.title }))) return;
        setDeleting(true);
        try {
            const res = await fetch(`/api/views/${encodeURIComponent(view.id)}`, { method: "DELETE" });
            if (!res.ok) throw new Error(await errorOf(res, t("deleteFailed")));
            toast.success(t("deleted"));
            router.push(afterDelete);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("deleteFailed"));
            setDeleting(false);
        }
    };
    return (
        <>
            <Button size="sm" variant="outline" onClick={() => setTransferOpen(true)}><IconUserShare aria-hidden />{t("transfer")}</Button>
            <Button size="sm" variant="ghost" disabled={deleting} onClick={remove} className="text-destructive hover:text-destructive"><IconTrash aria-hidden />{tc("delete")}</Button>
            {transferOpen && <TransferDialog view={view} people={transferTo} onClose={() => setTransferOpen(false)} />}
        </>
    );
}

function TransferDialog({ view, people, onClose }: { view: ViewDetail; people: Named[]; onClose: () => void }) {
    const t = useTranslations("views.detail");
    const tc = useTranslations("common");
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
                        if (!res.ok) throw new Error(await errorOf(res, t("transferFailed")));
                        toast.success(t("transferred"));
                        onClose();
                        router.refresh();
                    } catch (error) {
                        toast.error(error instanceof Error ? error.message : t("transferFailed"));
                    } finally {
                        setSaving(false);
                    }
                }}>
                    <DialogHeader>
                        <DialogTitle>{t("transferTitle")}</DialogTitle>
                        <DialogDescription>{t("transferDescription", { title: view.title })}</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-1.5">
                        <Label htmlFor="transfer-to">{t("newOwner")}</Label>
                        <select id="transfer-to" value={to} onChange={(e) => setTo(e.target.value)} required
                            className="h-10 rounded-xl border border-border bg-card px-3 text-sm text-foreground">
                            {candidates.map((p) => <option key={p.id} value={p.id}>{p.name ?? t("someone")}</option>)}
                        </select>
                    </div>
                    {candidates.length === 0 && <p className="text-sm text-muted-foreground">{t("nobodyCanSeeScope")}</p>}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>{tc("cancel")}</Button>
                        <Button type="submit" disabled={saving || !to}>{saving ? t("transferring") : t("transfer")}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Labelled by views.visibility.<key>. */
const VISIBILITY_OPTIONS = [
    { value: "private", key: "private" },
    { value: "shared", key: "shared" },
    { value: "scope", key: "everyone" },
] as const;

/** The owner's control: Private / Shared (with a people picker) / Everyone in scope. */
function VisibilityControl({ view }: { view: ViewDetail }) {
    const t = useTranslations("views.detail");
    const tVisibility = useTranslations("views.visibility");
    const router = useRouter();
    const [saving, setSaving] = useState(false);
    const [picking, setPicking] = useState(false);
    const save = async (visibility: string, shareUserIds?: string[]) => {
        setSaving(true);
        try {
            const res = await fetch(`/api/views/${encodeURIComponent(view.id)}/access`, {
                method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visibility, shareUserIds }),
            });
            if (!res.ok) throw new Error(await errorOf(res, t("visibilityFailed")));
            toast.success(visibility === "private" ? t("nowPrivate") : visibility === "shared" ? t("sharingUpdated") : t("nowEveryone"));
            router.refresh();
            return true;
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("visibilityFailed"));
            return false;
        } finally {
            setSaving(false);
        }
    };
    return (
        <section aria-labelledby="view-visibility-heading" className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
                <h2 id="view-visibility-heading" className="text-sm font-medium text-foreground">{t("whoCanSee")}</h2>
                <p className="text-xs text-muted-foreground">
                    {view.visibility === "private" && t("visibilityPrivate")}
                    {view.visibility === "shared" && t("visibilityShared", { people: view.sharedWith && view.sharedWith.length > 0 ? view.sharedWith.map((p) => p.name ?? t("someoneLower")).join(", ") : t("thePeopleYouPicked") })}
                    {view.visibility === "scope" && t("visibilityScope", { scope: view.scopeType })}
                </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <div role="radiogroup" aria-label={t("whoCanSee")} className="grid grid-cols-3 gap-1 rounded-xl border border-border bg-background p-1">
                    {VISIBILITY_OPTIONS.map((option) => (
                        <button key={option.value} type="button" role="radio" aria-checked={view.visibility === option.value} disabled={saving}
                            onClick={() => option.value === "shared" ? setPicking(true) : view.visibility !== option.value && void save(option.value)}
                            className={cn("whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs transition-colors sm:text-sm",
                                view.visibility === option.value ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
                            {tVisibility(option.key)}
                        </button>
                    ))}
                </div>
            </div>
            {picking && <SharePicker view={view} onClose={() => setPicking(false)} onSave={(ids) => save("shared", ids)} />}
        </section>
    );
}

function SharePicker({ view, onClose, onSave }: { view: ViewDetail; onClose: () => void; onSave: (ids: string[]) => Promise<boolean> }) {
    const t = useTranslations("views.detail");
    const tc = useTranslations("common");
    const [people, setPeople] = useState<Named[] | null>(null);
    const [chosen, setChosen] = useState<Set<string>>(() => new Set((view.sharedWith ?? []).map((p) => p.id)));
    const [filter, setFilter] = useState("");
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        let alive = true;
        fetch(`/api/views/${encodeURIComponent(view.id)}/access`).then(async (res) => {
            if (!res.ok) throw new Error(await errorOf(res, t("peopleFailed")));
            const data = await res.json() as { people: Named[] };
            if (alive) setPeople(data.people);
        }).catch((error) => { toast.error(error instanceof Error ? error.message : t("peopleFailed")); if (alive) setPeople([]); });
        return () => { alive = false; };
    }, [view.id, t]);
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
                        <DialogTitle>{t("shareTitle")}</DialogTitle>
                        <DialogDescription>{t("shareDescription")}</DialogDescription>
                    </DialogHeader>
                    <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("findPerson")} aria-label={t("findPerson")} />
                    <div className="max-h-72 overflow-y-auto rounded-xl border border-border">
                        {people === null && <p className="p-3 text-sm text-muted-foreground">{t("loading")}</p>}
                        {people !== null && shown.length === 0 && <p className="p-3 text-sm text-muted-foreground">{t("nobodyElseScope")}</p>}
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
                        <Button type="button" variant="ghost" onClick={onClose}>{tc("cancel")}</Button>
                        <Button type="submit" disabled={saving || chosen.size === 0}>{saving ? tc("saving") : t("shareWith", { count: chosen.size })}</Button>
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
    const t = useTranslations("views.detail");
    const tc = useTranslations("common");
    const cadence = useRefreshCadenceText();
    const [title, setTitle] = useState(view.title);
    const [description, setDescription] = useState(view.description ?? "");
    const [refresh, setRefresh] = useState<number | null>(view.refreshEveryMinutes);
    const [saving, setSaving] = useState(false);
    const known: { value: number | null; label: string }[] = REFRESH_CHOICES.map((c) => ({ value: c.value, label: t(`refreshChoices.${c.key}`) }));
    const choices = known.some((c) => c.value === refresh) ? known : [...known, { value: refresh, label: cadence(refresh ?? 0) }];
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
                        <DialogTitle>{t("editTitle")}</DialogTitle>
                        <DialogDescription>{t("editDescription")}</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-1.5">
                        <Label htmlFor="edit-view-title">{t("titleLabel")}</Label>
                        <Input id="edit-view-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={VIEW_TITLE_MAX} required />
                    </div>
                    <div className="grid gap-1.5">
                        <Label htmlFor="edit-view-description">{t("descriptionLabel")}</Label>
                        <Textarea id="edit-view-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={VIEW_DESCRIPTION_MAX} rows={4} />
                    </div>
                    <div className="grid gap-1.5">
                        <Label htmlFor="edit-view-refresh">{t("expectedRefresh")}</Label>
                        <select id="edit-view-refresh" value={refresh ?? ""} onChange={(e) => setRefresh(e.target.value ? Number(e.target.value) : null)}
                            className="h-10 rounded-xl border border-border bg-card px-3 text-sm text-foreground">
                            {choices.map((c) => <option key={c.value ?? "none"} value={c.value ?? ""}>{c.label}</option>)}
                        </select>
                        <p className="text-xs text-muted-foreground">{t("expectedRefreshHint")}</p>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>{tc("cancel")}</Button>
                        <Button type="submit" disabled={saving || !title.trim()}>{saving ? tc("saving") : tc("save")}</Button>
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
    const t = useTranslations("views.detail");
    const formatAgo = useFormatAgo();
    const now = useNowMs();
    const [versions, setVersions] = useState<VersionRow[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [reverting, setReverting] = useState<number | null>(null);

    const load = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/views/${encodeURIComponent(viewId)}/versions`);
            if (!res.ok) throw new Error(await errorOf(res, t("historyFailed")));
            setVersions(((await res.json()) as { versions: VersionRow[] }).versions);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("historyFailed"));
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
            if (!res.ok) throw new Error(await errorOf(res, t("revertFailed")));
            toast.success(t("reverted", { version }));
            onReverted();
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("revertFailed"));
        } finally {
            setReverting(null);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="top-0 right-0 left-auto h-dvh max-h-dvh w-full max-w-md translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none border-y-0 border-r-0 sm:max-w-md data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100">
                <DialogHeader>
                    <DialogTitle>{t("historyTitle")}</DialogTitle>
                    <DialogDescription>{t("historyDescription")}</DialogDescription>
                </DialogHeader>
                {loading && !versions && <p className="text-sm text-muted-foreground">{t("loading")}</p>}
                {versions && versions.length === 0 && <p className="text-sm text-muted-foreground">{t("noVersions")}</p>}
                {versions && versions.length > 0 && (
                    <ol className="divide-y divide-border rounded-xl border border-border">
                        {versions.map((v) => (
                            <li key={v.version} className="flex items-center justify-between gap-3 px-3 py-2.5">
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-foreground">
                                        {t("versionTitle", { version: v.version })}{v.current && <span className="ml-2 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{t("current")}</span>}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {v.title} · {t("panels", { count: v.panelCount })} · {v.author.name ?? (v.author.type === "agent" ? t("anAgent") : t("someoneLower"))} · {formatAgo(v.createdAt, now)}
                                    </p>
                                </div>
                                {canRevert && !v.current && (
                                    <Button size="xs" variant="outline" disabled={reverting !== null} onClick={() => revert(v.version)}>
                                        {reverting === v.version ? t("reverting") : t("revert")}
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
