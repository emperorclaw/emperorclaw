"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type SyntheticEvent } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { IconChevronDown } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useApiError } from "@/lib/i18n/use-api-error";
import { cn } from "@/lib/utils";
import { visibilityChangeNarrows } from "@/lib/view-access";
import { PersonChip, VISIBILITY_BADGE_CLASS, VisibilityBadge, useAudienceText, useVisibilityText, VisibilityIcon } from "./view-meta";

type Named = { id: string; name: string | null };

/** What the menu needs from a view (a list row's ViewSummary or the page's ViewDetail). */
export type VisibilityMenuView = {
    id: string;
    visibility: string;
    sharedCount: number | null;
    scopeType: string;
    scopeLabel: string | null;
    owner: Named | null;
};

async function errorOf(res: Response, fallback: string): Promise<string> {
    const data = await res.json().catch(() => ({})) as { error?: string };
    return data.error || fallback;
}

/**
 * The menu content is portaled to <body>, but React still bubbles its events
 * up the component tree: through the badge into the list row. They stop at
 * the content, so nothing on the row (or a future row handler) sees them.
 */
const stop = (event: SyntheticEvent) => event.stopPropagation();
const STOP_ROW_EVENTS = { onClick: stop, onPointerDown: stop, onPointerUp: stop, onMouseDown: stop, onMouseUp: stop } as const;

/**
 * Saves who sees a view (PUT /api/views/:id/access) with the toast and a
 * refresh of the server-rendered page, so the list row or the view header
 * shows the new state. One implementation for both.
 */
export function useSaveVisibility(view: VisibilityMenuView) {
    const t = useTranslations("views.detail");
    const apiError = useApiError();
    const audienceText = useAudienceText();
    const router = useRouter();
    const [saving, setSaving] = useState(false);
    const save = async (visibility: string, shareUserIds?: string[]): Promise<boolean> => {
        setSaving(true);
        try {
            const res = await fetch(`/api/views/${encodeURIComponent(view.id)}/access`, {
                method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visibility, shareUserIds }),
            });
            if (!res.ok) throw new Error(await errorOf(res, t("visibilityFailed")));
            toast.success(visibility === "private" ? t("nowPrivate") : visibility === "shared" ? t("sharingUpdated") : t("nowVisibleTo", { audience: audienceText(view) }));
            router.refresh();
            return true;
        } catch (error) {
            toast.error(apiError(error instanceof Error ? error.message : null, t("visibilityFailed")));
            return false;
        } finally {
            setSaving(false);
        }
    };
    return { save, saving };
}

/**
 * The visibility badge, as a menu for whoever may change it (the owner, or an
 * owner/admin on a view with no owner: lib/view-access.ts mayChangeVisibility):
 * Private / Shared with… (people picker) / Everyone in the company (or on the
 * project, at the client). Anyone else gets the plain badge.
 */
export function VisibilityMenu({ view, canChange, description, className }: {
    view: VisibilityMenuView;
    canChange: boolean;
    /** A sentence on who sees it now, shown at the top of the menu. */
    description?: string;
    className?: string;
}) {
    const t = useTranslations("views.detail");
    const tVisibility = useTranslations("views.visibility");
    const visibilityText = useVisibilityText();
    const audienceText = useAudienceText();
    const { save, saving } = useSaveVisibility(view);
    const [picking, setPicking] = useState(false);
    if (!canChange) return <VisibilityBadge view={view} className={className} />;
    const label = visibilityText(view);
    const options = [
        { value: "private", text: tVisibility("private") },
        { value: "shared", text: tVisibility("sharedPick") },
        { value: "scope", text: audienceText(view) },
    ];
    const choose = (value: string) => {
        // Taking it away from everyone in scope says who loses access first (window.confirm, as archive and delete do).
        if (visibilityChangeNarrows(view.visibility, value)) {
            const scope = view.scopeType === "company" ? "company" : "other";
            if (!window.confirm(value === "private" ? t("confirmPrivate", { scope }) : t("confirmShared", { scope }))) return;
        }
        // Shared asks who (also while shared: it reopens the people picker).
        if (value === "shared") setPicking(true);
        else if (value !== view.visibility) void save(value);
    };
    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild disabled={saving}>
                    <button type="button" aria-label={t("changeWhoCanSee", { current: label })}
                        className={cn(VISIBILITY_BADGE_CLASS, "cursor-pointer transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60", className)}>
                        <VisibilityIcon visibility={view.visibility} />{label}<IconChevronDown className="h-3 w-3" aria-hidden />
                    </button>
                </DropdownMenuTrigger>
                {/* Portaled to <body> and stacked above every list row (whose title link is
                    stretched over the row, its badge layer at z-10): a click on an item
                    lands on the item, never on the row underneath. */}
                <DropdownMenuContent align="start" className="z-[60] w-72" {...STOP_ROW_EVENTS}>
                    <DropdownMenuLabel>{t("whoCanSee")}</DropdownMenuLabel>
                    {description && <p className="px-2 pb-1.5 text-xs text-muted-foreground">{description}</p>}
                    {!view.owner && <p className="px-2 pb-1.5 text-xs text-muted-foreground">{t("claimHint")}</p>}
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioGroup value={view.visibility}>
                        {options.map((option) => (
                            // Each item acts on its own select (its click, or Enter/Space), not on the
                            // group's value change: re-picking the current value still runs (Shared
                            // reopens the picker). It runs once the menu has closed, so the confirm
                            // or the picker dialog opens on a settled page.
                            <DropdownMenuRadioItem key={option.value} value={option.value}
                                onSelect={() => { window.setTimeout(() => choose(option.value), 0); }}>
                                {option.text}
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>
            {picking && <SharePicker viewId={view.id} onClose={() => setPicking(false)} onSave={(ids) => save("shared", ids)} />}
        </>
    );
}

function SharePicker({ viewId, onClose, onSave }: { viewId: string; onClose: () => void; onSave: (ids: string[]) => Promise<boolean> }) {
    const t = useTranslations("views.detail");
    const apiError = useApiError();
    const tc = useTranslations("common");
    const [people, setPeople] = useState<Named[] | null>(null);
    // Why the people list did not load; the dialog offers a retry instead of an empty list.
    const [loadError, setLoadError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [chosen, setChosen] = useState<Set<string>>(() => new Set());
    const [filter, setFilter] = useState("");
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        let alive = true;
        fetch(`/api/views/${encodeURIComponent(viewId)}/access`).then(async (res) => {
            if (!res.ok) throw new Error(await errorOf(res, t("peopleFailed")));
            const data = await res.json() as { people: Named[]; sharedWith?: string[] };
            if (!alive) return;
            setPeople(data.people);
            // Start from who it is shared with now.
            setChosen(new Set(data.sharedWith ?? []));
        }).catch((error) => {
            if (alive) setLoadError(apiError(error instanceof Error ? error.message : null, t("peopleFailed")));
        });
        return () => { alive = false; };
    }, [viewId, t, apiError, attempt]);
    const retry = () => { setLoadError(null); setPeople(null); setAttempt((n) => n + 1); };
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
                    <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("findPerson")} aria-label={t("findPerson")} disabled={loadError !== null} />
                    <div className="max-h-72 overflow-y-auto rounded-xl border border-border">
                        {loadError !== null ? (
                            <div role="alert" className="flex items-center justify-between gap-3 p-3 text-sm">
                                <span className="text-destructive">{loadError}</span>
                                <Button type="button" variant="outline" size="sm" onClick={retry}>{tc("retry")}</Button>
                            </div>
                        ) : (
                            <>
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
                            </>
                        )}
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>{tc("cancel")}</Button>
                        <Button type="submit" disabled={saving || chosen.size === 0 || loadError !== null}>{saving ? tc("saving") : t("shareWith", { count: chosen.size })}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
