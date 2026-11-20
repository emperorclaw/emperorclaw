"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { IconDots, IconEye, IconEyeOff, IconKey, IconRotate, IconSearch, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Presence } from "@/components/ui/motion";
import { useTimeAgo } from "@/lib/i18n/format";
import { useViewerPermissions } from "@/lib/use-viewer-permissions";

type AgentSecret = {
    id: string;
    name: string;
    version: number;
    exposeToTools: boolean;
    updatedAt: string;
};

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function mergeSecret(secrets: AgentSecret[], secret: AgentSecret): AgentSecret[] {
    return [...secrets.filter((existing) => existing.id !== secret.id), secret]
        .sort((left, right) => left.name.localeCompare(right.name));
}

export function AgentSecretsSection({ agentId, ownerUserId }: {
    agentId: string;
    ownerUserId: string | null;
}) {
    const t = useTranslations("agents.detail.secrets");
    const tc = useTranslations("common");
    const timeAgo = useTimeAgo();
    const { loaded: permissionsLoaded, canAdmin } = useViewerPermissions();
    const { data: session, status } = useSession();
    const currentUserId = (session?.user as { id?: string } | undefined)?.id;
    const isOwner = Boolean(currentUserId && ownerUserId && currentUserId === ownerUserId);
    const mayManage = canAdmin || isOwner;
    const permissionKnown = permissionsLoaded && (canAdmin || status !== "loading");

    const [view, setView] = useState<"pending" | "ready" | "hidden">("pending");
    const [secrets, setSecrets] = useState<AgentSecret[]>([]);
    const [name, setName] = useState("");
    const [value, setValue] = useState("");
    const [rotateName, setRotateName] = useState<string | null>(null);
    const [showValue, setShowValue] = useState(false);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const [unavailable, setUnavailable] = useState(false);
    const [confirming, setConfirming] = useState<AgentSecret | null>(null);
    const valueRef = useRef<HTMLInputElement>(null);
    const nameId = useId();
    const valueId = useId();
    const errorId = useId();

    useEffect(() => {
        setSecrets([]);
        setName("");
        setValue("");
        setRotateName(null);
        setShowValue(false);
        setDialogOpen(false);
        setQuery("");
        setError(null);
        setListError(null);
        setUnavailable(false);
        setConfirming(null);
    }, [agentId]);

    useEffect(() => {
        if (!permissionKnown || !mayManage) return;
        let cancelled = false;
        setView("pending");
        fetch(`/api/agents/${agentId}/env-vars`, { cache: "no-store" })
            .then(async (response) => {
                if (cancelled) return;
                if (response.status === 403) {
                    setView("hidden");
                    return;
                }
                if (response.status === 503) {
                    setUnavailable(true);
                    setView("ready");
                    return;
                }
                const data = await response.json().catch(() => null);
                if (!response.ok) {
                    setListError(typeof data?.error === "string" ? data.error : t("loadFailed"));
                    setView("ready");
                    return;
                }
                setSecrets(Array.isArray(data?.secrets) ? data.secrets as AgentSecret[] : []);
                setView("ready");
            })
            .catch((cause) => {
                if (cancelled) return;
                setListError(cause instanceof Error ? cause.message : t("loadFailed"));
                setView("ready");
            });
        return () => { cancelled = true; };
    }, [agentId, mayManage, permissionKnown, t]);

    useEffect(() => {
        if (dialogOpen) valueRef.current?.focus();
    }, [dialogOpen, rotateName]);

    if (!permissionKnown || !mayManage || view !== "ready") return null;

    if (unavailable) {
        return (
            <section className="space-y-4">
                <div role="alert" className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-4 py-3 text-xs text-amber-800 dark:text-amber-200">
                    {t("unavailable")}
                </div>
            </section>
        );
    }

    const openAdd = () => {
        setRotateName(null);
        setName("");
        setValue("");
        setShowValue(false);
        setError(null);
        setDialogOpen(true);
    };

    const startRotate = (secret: AgentSecret) => {
        setRotateName(secret.name);
        setName(secret.name);
        setValue("");
        setShowValue(false);
        setError(null);
        setDialogOpen(true);
    };

    const cancelRotate = () => {
        setRotateName(null);
        setName("");
        setValue("");
        setShowValue(false);
        setError(null);
        setDialogOpen(false);
    };

    const saveSecret = async () => {
        if (saving) return;
        const secretName = name.trim();
        if (!NAME_RE.test(secretName)) {
            setError(t("invalidName"));
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const response = await fetch(`/api/agents/${agentId}/env-vars`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: secretName, value }),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) {
                if (response.status === 403) {
                    setValue("");
                    setError(typeof data?.error === "string" ? data.error : t("saveFailed"));
                    return;
                }
                if (response.status === 503) {
                    setDialogOpen(false);
                    setUnavailable(true);
                    return;
                }
                setError(typeof data?.error === "string" ? data.error : t("saveFailed"));
                return;
            }
            setValue("");
            setShowValue(false);
            setName("");
            setRotateName(null);
            setDialogOpen(false);
            setListError(null);
            if (data?.secret) setSecrets((previous) => mergeSecret(previous, data.secret as AgentSecret));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t("saveFailed"));
        } finally {
            setSaving(false);
        }
    };

    const deleteSecret = async (secret: AgentSecret) => {
        if (deleting) return;
        setDeleting(true);
        try {
            const response = await fetch(`/api/agents/${agentId}/env-vars/${secret.id}`, { method: "DELETE" });
            if (response.status === 403) {
                setValue("");
                setConfirming(null);
                setView("hidden");
                return;
            }
            if (response.status === 404) {
                setSecrets((previous) => previous.filter((existing) => existing.id !== secret.id));
                setListError(null);
                setConfirming(null);
                return;
            }
            if (!response.ok) {
                const data = await response.json().catch(() => null);
                toast.error(typeof data?.error === "string" ? data.error : t("deleteFailed"));
                setConfirming(null);
                return;
            }
            setSecrets((previous) => previous.filter((existing) => existing.id !== secret.id));
            setListError(null);
            setConfirming(null);
            toast.success(t("deleted", { name: secret.name }));
        } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : t("deleteFailed"));
            setConfirming(null);
        } finally {
            setDeleting(false);
        }
    };

    const formDisabled = saving || unavailable;
    const inputDescribedBy = error ? errorId : undefined;
    const trimmedQuery = query.trim();
    const filteredSecrets = trimmedQuery
        ? secrets.filter((secret) => secret.name.toLowerCase().includes(trimmedQuery.toLowerCase()))
        : secrets;

    return (
        <section className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <IconKey className="h-4 w-4 text-cyan-400" aria-hidden="true" />
                        <h3 className="text-sm font-semibold text-zinc-100">{t("title")}</h3>
                        <Badge variant="secondary" className="text-[10px]">{secrets.length}</Badge>
                    </div>
                    <p className="text-xs text-zinc-500">{t("help")}</p>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <Button type="button" size="sm" onClick={openAdd} disabled={formDisabled}>
                        {t("add")}
                    </Button>
                    <div className="relative min-w-0 flex-1 sm:flex-none">
                        <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t("searchPlaceholder")}
                            className="h-9 pl-8 sm:w-56"
                        />
                    </div>
                </div>
            </div>

            <Presence show={Boolean(listError)}>
                <p role="alert" className="text-xs text-destructive">{listError}</p>
            </Presence>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 divide-y divide-zinc-800">
                {secrets.length === 0 ? (
                    <p className="p-6 text-center text-xs text-zinc-500">{t("empty")}</p>
                ) : filteredSecrets.length === 0 ? (
                    <p className="p-6 text-center text-xs text-zinc-500">{t("noMatches", { query: trimmedQuery })}</p>
                ) : filteredSecrets.map((secret) => (
                    <div key={secret.id} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3">
                        <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="break-all font-mono text-sm text-zinc-100">{secret.name}</span>
                                <Badge variant="secondary" className="text-[10px]">{t("version", { version: secret.version })}</Badge>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                                <span>{t("updated", { ago: timeAgo(secret.updatedAt, new Date()) })}</span>
                                {secret.exposeToTools && <span>{t("exposedToTools")}</span>}
                            </div>
                        </div>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button type="button" variant="ghost" size="icon-sm" aria-label={tc("moreActions")} title={tc("moreActions")} disabled={formDisabled || deleting}>
                                    <IconDots className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => startRotate(secret)} disabled={formDisabled}>
                                    <IconRotate /> {t("rotate")}
                                </DropdownMenuItem>
                                <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(secret)} disabled={deleting}>
                                    <IconTrash /> {t("delete")}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                ))}
            </div>

            <Dialog open={dialogOpen} onOpenChange={(next) => { if (!next) cancelRotate(); }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{rotateName ? t("rotateTitle", { name: rotateName }) : t("addTitle")}</DialogTitle>
                    </DialogHeader>

                    <div className="space-y-3">
                        <div className="space-y-1.5">
                            <Label htmlFor={nameId} className="text-xs">{t("name")}</Label>
                            <Input
                                id={nameId}
                                value={name}
                                onChange={(event) => { setName(event.target.value.toUpperCase()); setError(null); }}
                                placeholder={t("namePlaceholder")}
                                autoComplete="off"
                                autoCapitalize="characters"
                                spellCheck={false}
                                maxLength={64}
                                disabled={formDisabled || Boolean(rotateName)}
                                aria-invalid={Boolean(error)}
                                aria-describedby={inputDescribedBy}
                                className="h-9 font-mono"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor={valueId} className="text-xs">{t("value")}</Label>
                            <div className="flex min-w-0 items-center gap-2">
                                <Input
                                    id={valueId}
                                    ref={valueRef}
                                    type={showValue ? "text" : "password"}
                                    value={value}
                                    onChange={(event) => { setValue(event.target.value); setError(null); }}
                                    placeholder={t("valuePlaceholder")}
                                    autoComplete="off"
                                    aria-invalid={Boolean(error)}
                                    aria-describedby={inputDescribedBy}
                                    disabled={formDisabled}
                                    className="h-9 min-w-0 flex-1 font-mono"
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon-sm"
                                    onClick={() => setShowValue((current) => !current)}
                                    disabled={formDisabled}
                                    aria-label={showValue ? t("hideValue") : t("showValue")}
                                    aria-pressed={showValue}
                                >
                                    {showValue ? <IconEyeOff /> : <IconEye />}
                                </Button>
                            </div>
                        </div>
                        <Presence show={Boolean(error)}>
                            <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>
                        </Presence>
                    </div>

                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={cancelRotate} disabled={saving}>
                            {t("cancel")}
                        </Button>
                        <Button type="button" onClick={() => void saveSecret()} disabled={formDisabled}>
                            {saving ? tc("saving") : rotateName ? t("save") : t("add")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <ConfirmDialog
                open={Boolean(confirming)}
                title={confirming ? t("deleteTitle", { name: confirming.name }) : ""}
                description={t("deleteBody")}
                confirmLabel={t("deleteConfirm")}
                destructive
                onConfirm={() => { if (confirming) void deleteSecret(confirming); }}
                onCancel={() => setConfirming(null)}
            />
        </section>
    );
}
