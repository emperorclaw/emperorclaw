"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MotionItem, MotionList, Presence } from "@/components/ui/motion";
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
        if (rotateName) valueRef.current?.focus();
    }, [rotateName]);

    if (!permissionKnown || !mayManage || view !== "ready") return null;

    const startRotate = (secret: AgentSecret) => {
        setRotateName(secret.name);
        setName(secret.name);
        setValue("");
        setShowValue(false);
        setError(null);
    };

    const cancelRotate = () => {
        setRotateName(null);
        setName("");
        setValue("");
        setShowValue(false);
        setError(null);
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

    return (
        <section className="border-b border-border px-4 py-4 sm:px-5">
            <div className="mx-auto max-w-3xl space-y-3">
                <div className="space-y-1">
                    <h3 className="text-sm font-medium text-foreground">{t("title")}</h3>
                    <p className="text-xs text-muted-foreground">{t("help")}</p>
                </div>

                {unavailable && (
                    <div role="alert" className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                        {t("unavailable")}
                    </div>
                )}

                <Presence show={Boolean(listError)}>
                    <p role="alert" className="text-xs text-destructive">{listError}</p>
                </Presence>

                <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3 sm:p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                            {rotateName ? t("rotateTitle", { name: rotateName }) : t("addTitle")}
                        </h4>
                        {rotateName && (
                            <Button type="button" variant="ghost" size="xs" onClick={cancelRotate} disabled={saving}>
                                {tc("cancel")}
                            </Button>
                        )}
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
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
                                readOnly={Boolean(rotateName)}
                                aria-readonly={rotateName ? true : undefined}
                                aria-invalid={Boolean(error)}
                                aria-describedby={inputDescribedBy}
                                disabled={formDisabled}
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
                    </div>

                    <Presence show={Boolean(error)}>
                        <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>
                    </Presence>

                    <div className="flex justify-end">
                        <Button type="button" size="sm" onClick={() => void saveSecret()} disabled={formDisabled}>
                            {saving ? tc("saving") : rotateName ? t("save") : t("add")}
                        </Button>
                    </div>
                </div>

                {secrets.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("empty")}</p>
                ) : (
                    <MotionList>
                        {secrets.map((secret) => (
                            <MotionItem key={secret.id} className="rounded-xl border border-border bg-muted/30 px-3 py-2">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                    <div className="min-w-0 space-y-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="break-all font-mono text-sm text-foreground">{secret.name}</span>
                                            <span className="text-[10px] font-medium text-muted-foreground">{t("version", { version: secret.version })}</span>
                                            {secret.exposeToTools && (
                                                <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                                    {t("exposedToTools")}
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                            <span aria-hidden="true" className="font-mono tracking-wider">{"••••••••"}</span>
                                            <span>{t("updated", { ago: timeAgo(secret.updatedAt, new Date()) })}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="xs"
                                            onClick={() => startRotate(secret)}
                                            disabled={formDisabled}
                                            aria-label={t("rotateNamed", { name: secret.name })}
                                        >
                                            {t("rotate")}
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="xs"
                                            className="text-destructive hover:text-destructive"
                                            onClick={() => setConfirming(secret)}
                                            disabled={deleting}
                                            aria-label={t("deleteNamed", { name: secret.name })}
                                        >
                                            {t("delete")}
                                        </Button>
                                    </div>
                                </div>
                            </MotionItem>
                        ))}
                    </MotionList>
                )}
            </div>

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
