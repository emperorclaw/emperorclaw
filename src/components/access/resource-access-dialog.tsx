"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useApiError } from "@/lib/i18n/use-api-error";
import { IconLock, IconTrash, IconUserPlus } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PersonChip } from "@/components/views/view-meta";
import { RESOURCE_ROLES, type ResourceRole, type ResourceType } from "@/lib/resource-roles";
import { cn } from "@/lib/utils";

type Person = {
    userId: string;
    name: string;
    email: string | null;
    role: ResourceRole;
    via: { type: "customer"; id: string; name: string } | null;
    restricted: boolean;
};
type Candidate = { userId: string; name: string; email: string | null };
type AccessData = {
    resource: { type: ResourceType; id: string; name: string };
    people: Person[];
    canManage: boolean;
    candidates: Candidate[];
    canInvite: boolean;
};

async function errorOf(res: Response, fallback: string): Promise<string> {
    const data = await res.json().catch(() => ({})) as { error?: string };
    return data.error || fallback;
}

function accessUrl(type: ResourceType, id: string): string {
    return type === "customer" ? `/api/customers/${encodeURIComponent(id)}/access` : `/api/projects/${encodeURIComponent(id)}/access`;
}

const selectClass = "h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground disabled:opacity-60";

function RoleSelect({ value, onChange, disabled, label }: { value: ResourceRole; onChange: (role: ResourceRole) => void; disabled?: boolean; label: string }) {
    const tRole = useTranslations("access.roles");
    return (
        <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as ResourceRole)} className={selectClass}>
            {RESOURCE_ROLES.map((role) => <option key={role} value={role}>{tRole(role)}</option>)}
        </select>
    );
}

/**
 * The "Access" button on a client or project page (0.20): who has access, and
 * for its admins, add a person (an existing member or an invite by email) with
 * Admin / Can edit / Can view. Mirrors the view share dialog.
 */
export function ResourceAccessButton({ type, id, className }: { type: ResourceType; id: string; className?: string }) {
    const t = useTranslations("access.resource");
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button size="sm" variant="outline" className={className} onClick={() => setOpen(true)}>
                <IconLock aria-hidden />{t("access")}
            </Button>
            {open && <ResourceAccessDialog type={type} id={id} onClose={() => setOpen(false)} />}
        </>
    );
}

function ResourceAccessDialog({ type, id, onClose }: { type: ResourceType; id: string; onClose: () => void }) {
    const t = useTranslations("access.resource");
    const apiError = useApiError();
    const tRole = useTranslations("access.roles");
    const tc = useTranslations("common");
    const [data, setData] = useState<AccessData | null>(null);
    const [busy, setBusy] = useState(false);
    const [adding, setAdding] = useState(false);
    const url = accessUrl(type, id);

    const load = useCallback(async () => {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(await errorOf(res, t("loadFailed")));
        setData(await res.json() as AccessData);
    }, [url, t]);

    useEffect(() => {
        load().catch((error) => { toast.error(apiError(error instanceof Error ? error.message : null, t("loadFailed"))); onClose(); });
    }, [load, onClose, t, apiError]);

    const send = async (method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>, success: string) => {
        setBusy(true);
        try {
            const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            if (!res.ok) throw new Error(await errorOf(res, t("changeFailed")));
            const out = await res.json() as { invited?: { email: string; inviteUrl: string; emailSent: boolean } };
            if (out.invited && !out.invited.emailSent) {
                await navigator.clipboard?.writeText(out.invited.inviteUrl).catch(() => {});
                toast.success(t("invitationCreated", { email: out.invited.email }));
            } else {
                toast.success(success);
            }
            await load();
            return true;
        } catch (error) {
            toast.error(apiError(error instanceof Error ? error.message : null, t("changeFailed")));
            return false;
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{data ? t("titleWithName", { name: data.resource.name }) : t("access")}</DialogTitle>
                    <DialogDescription>
                        {t("description", { type })}
                    </DialogDescription>
                </DialogHeader>
                <div className="max-h-80 overflow-y-auto rounded-xl border border-border">
                    {data === null && <p className="p-3 text-sm text-muted-foreground">{t("loading")}</p>}
                    {data !== null && data.people.length === 0 && (
                        <p className="p-3 text-sm text-muted-foreground">{t("empty")}</p>
                    )}
                    <ul className="divide-y divide-border">
                        {(data?.people ?? []).map((person) => (
                            <li key={`${person.userId}-${person.via?.id ?? "own"}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                                <span className="min-w-0 flex-1">
                                    <PersonChip name={person.name} className="text-sm text-foreground" />
                                    <span className="block truncate pl-[26px] text-xs text-muted-foreground">
                                        {[person.via ? t("through", { name: person.via.name }) : person.email, person.restricted ? t("restricted") : null].filter(Boolean).join(" · ")}
                                    </span>
                                </span>
                                {person.via || !data?.canManage ? (
                                    <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">{tRole(person.role)}</span>
                                ) : (
                                    <>
                                        <RoleSelect label={t("roleOf", { name: person.name })} value={person.role} disabled={busy}
                                            onChange={(role) => void send("PATCH", { userId: person.userId, role }, t("updated"))} />
                                        <Button size="icon" variant="ghost" disabled={busy} aria-label={t("remove", { name: person.name })} className="text-muted-foreground hover:text-destructive"
                                            onClick={() => void send("DELETE", { userId: person.userId }, t("removed"))}>
                                            <IconTrash aria-hidden />
                                        </Button>
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
                <DialogFooter className="gap-2 sm:justify-between">
                    {data?.canManage ? (
                        <Button variant="outline" disabled={busy} onClick={() => setAdding(true)}><IconUserPlus aria-hidden />{t("addPerson")}</Button>
                    ) : <span className="text-xs text-muted-foreground">{t("onlyAdmins", { type })}</span>}
                    <Button variant="ghost" onClick={onClose}>{tc("done")}</Button>
                </DialogFooter>
                {adding && data && (
                    <AddPersonDialog data={data} busy={busy} onClose={() => setAdding(false)}
                        onAdd={async (body) => { const ok = await send("POST", body, t("added")); if (ok) setAdding(false); }} />
                )}
            </DialogContent>
        </Dialog>
    );
}

function AddPersonDialog({ data, busy, onClose, onAdd }: {
    data: AccessData;
    busy: boolean;
    onClose: () => void;
    onAdd: (body: { userId?: string; email?: string; role: ResourceRole }) => Promise<void>;
}) {
    const t = useTranslations("access.resource");
    const tRole = useTranslations("access.roles");
    const tc = useTranslations("common");
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState<string | null>(null);
    const [role, setRole] = useState<ResourceRole>("editor");
    const q = query.trim().toLowerCase();
    const matches = data.candidates.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q)).slice(0, 50);
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query.trim());
    const inviteNew = data.canInvite && looksLikeEmail && !data.candidates.some((c) => (c.email ?? "").toLowerCase() === q);
    return (
        <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
            <DialogContent>
                <form className="grid gap-4" onSubmit={async (event) => {
                    event.preventDefault();
                    if (picked) await onAdd({ userId: picked, role });
                    else if (inviteNew) await onAdd({ email: query.trim(), role });
                }}>
                    <DialogHeader>
                        <DialogTitle>{t("addPerson")}</DialogTitle>
                        <DialogDescription>
                            {data.canInvite ? t("pickOrInvite", { type: data.resource.type }) : t("pickMember")}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-1.5">
                        <Label htmlFor="access-person">{t("person")}</Label>
                        <Input id="access-person" value={query} autoComplete="off" placeholder={data.canInvite ? t("nameOrEmail") : t("findMember")}
                            onChange={(e) => { setQuery(e.target.value); setPicked(null); }} />
                    </div>
                    <div className="max-h-56 overflow-y-auto rounded-xl border border-border">
                        <ul className="divide-y divide-border">
                            {matches.map((c) => (
                                <li key={c.userId}>
                                    <button type="button" onClick={() => setPicked(c.userId)} aria-pressed={picked === c.userId}
                                        className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/60", picked === c.userId && "bg-accent")}>
                                        <PersonChip name={c.name} className="text-sm text-foreground" />
                                        <span className="ml-auto truncate text-xs text-muted-foreground">{c.email}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {matches.length === 0 && !inviteNew && <p className="p-3 text-sm text-muted-foreground">{t("noMatch")}</p>}
                        {inviteNew && <p className="p-3 text-sm text-foreground">{t.rich("invite", { email: query.trim(), name: data.resource.name, strong: (chunks) => <strong>{chunks}</strong> })}</p>}
                    </div>
                    <div className="grid gap-1.5">
                        <Label htmlFor="access-role">{t("role")}</Label>
                        <select id="access-role" value={role} onChange={(e) => setRole(e.target.value as ResourceRole)} className={cn(selectClass, "h-10 rounded-xl px-3")}>
                            {RESOURCE_ROLES.map((r) => <option key={r} value={r}>{tRole(r)}</option>)}
                        </select>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>{tc("cancel")}</Button>
                        <Button type="submit" disabled={busy || (!picked && !inviteNew)}>{inviteNew && !picked ? t("sendInvite") : t("add")}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
