"use client";

import { useCallback, useEffect, useState } from "react";
import { IconBell, IconBrandDiscord, IconBrandSlack, IconCheck, IconMail, IconWebhook } from "@tabler/icons-react";
import { useFormatter, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { SettingsSwitch as Toggle } from "@/components/ui/settings-switch";

type Kind = { kind: string; label: string };
type Webhook = { urlHint: string; format: string; kinds: string[]; enabled: boolean; lastDeliveryAt: string | null; lastError: string | null };

/** An example URL, not copy. */
const WEBHOOK_URL_EXAMPLE = "https://hooks.slack.com/services/…";

/** Webhook kinds with a label under settings.notifications.webhookKinds (anything else shows as is). */
const WEBHOOK_KINDS = { mention: "mention", decision: "decision", approval: "approval", task_assigned: "taskAssigned", agent_failed: "agentFailed", agent_down: "agentDown", incident: "incident" } as const;


/**
 * Notifications: your email choices, plus (for admins) the company webhook.
 * Everything always reaches the in-app inbox (the bell in the sidebar).
 */
export function NotificationSettingsTab({ isAdmin }: { isAdmin: boolean }) {
    const t = useTranslations("settings.notifications");
    const tc = useTranslations("common");
    const format = useFormatter();
    const [kinds, setKinds] = useState<Kind[]>([]);
    const [emailKinds, setEmailKinds] = useState<string[]>([]);
    const [emailConfigured, setEmailConfigured] = useState(true);
    const [savedPrefs, setSavedPrefs] = useState(false);
    const [savingPrefs, setSavingPrefs] = useState(false);
    const [prefsLoaded, setPrefsLoaded] = useState(false);
    const [prefsError, setPrefsError] = useState<string | null>(null);
    const [hookLoaded, setHookLoaded] = useState(false);
    const [hookLoadError, setHookLoadError] = useState(false);

    const [hook, setHook] = useState<Webhook | null>(null);
    const [hookKinds, setHookKinds] = useState<string[]>(["decision", "approval", "agent_failed", "incident"]);
    const [allKinds, setAllKinds] = useState<string[]>([]);
    const [canStoreSecrets, setCanStoreSecrets] = useState(true);
    const [url, setUrl] = useState("");
    const [hookMessage, setHookMessage] = useState<{ ok: boolean; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const loadPrefs = useCallback(async () => {
        setPrefsError(null);
        try {
            const res = await fetch("/api/notifications/preferences");
            if (!res.ok) throw new Error("load");
            const data = await res.json();
            setKinds(data.kinds);
            setEmailKinds(data.emailKinds);
            setEmailConfigured(data.emailConfigured);
            setPrefsLoaded(true);
        } catch {
            setPrefsError(t("prefsLoadFailed"));
        }
    }, [t]);
    const loadHook = useCallback(async () => {
        if (!isAdmin) return;
        setHookLoadError(false);
        try {
            const res = await fetch("/api/notifications/webhook");
            if (!res.ok) throw new Error("load");
            const data = await res.json();
            setCanStoreSecrets(data.canStoreSecrets);
            setAllKinds(data.kinds);
            setHook(data.webhook ?? null);
            if (data.webhook) setHookKinds(data.webhook.kinds);
            setHookLoaded(true);
        } catch {
            setHookLoadError(true);
        }
    }, [isAdmin]);
    useEffect(() => { void loadPrefs(); void loadHook(); }, [loadPrefs, loadHook]);

    const savePrefs = async (next: string[]) => {
        if (!prefsLoaded || savingPrefs) return;
        const previous = emailKinds;
        setSavingPrefs(true);
        setSavedPrefs(false);
        setPrefsError(null);
        setEmailKinds(next);
        try {
            const res = await fetch("/api/notifications/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emailKinds: next }) });
            if (!res.ok) throw new Error("save");
            setSavedPrefs(true);
            setTimeout(() => setSavedPrefs(false), 1500);
        } catch {
            setEmailKinds(previous);
            setPrefsError(t("prefsSaveFailed"));
        } finally {
            setSavingPrefs(false);
        }
    };

    const saveHook = async (patch: Record<string, unknown>) => {
        if (busy || !hookLoaded) return;
        setBusy(true);
        setHookMessage(null);
        try {
            const res = await fetch("/api/notifications/webhook", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || t("hookSaveFailed"));
            setHook((prev) => ({ ...(prev ?? { lastDeliveryAt: null, lastError: null }), ...data.webhook }));
            setUrl("");
            setHookMessage({ ok: true, text: t("hookSaved") });
        } catch (e) {
            if (hook && patch.kinds) setHookKinds(hook.kinds);
            setHookMessage({ ok: false, text: e instanceof Error ? e.message : t("hookSaveFailed") });
        } finally {
            setBusy(false);
        }
    };

    const testHook = async () => {
        setBusy(true);
        setHookMessage(null);
        try {
        const res = await fetch("/api/notifications/webhook/test", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        setHookMessage(res.ok ? { ok: true, text: t("testSent") } : { ok: false, text: data.error || t("testRejected") });
        setHook((prev) => prev && (res.ok
            ? { ...prev, lastDeliveryAt: new Date().toISOString(), lastError: null }
            : { ...prev, lastError: data.error || t("deliveryFailed") }));
        } catch {
            setHookMessage({ ok: false, text: t("testFailed") });
        } finally {
            setBusy(false);
        }
    };

    const removeHook = async () => {
        setBusy(true);
        setHookMessage(null);
        try {
            const res = await fetch("/api/notifications/webhook", { method: "DELETE" });
            if (!res.ok) throw new Error("remove");
            setHook(null);
            setHookMessage({ ok: true, text: t("hookRemoved") });
        } catch {
            setHookMessage({ ok: false, text: t("hookRemoveFailed") });
        } finally {
            setBusy(false);
        }
    };

    return (
        <section id="notifications" className="grid gap-4 lg:grid-cols-2">
            <article className="emperor-panel rounded-2xl p-4 sm:rounded-2xl sm:p-6">
                <div className="flex items-center gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10 text-primary"><IconMail className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-base font-semibold text-foreground">{t("emailTitle")}</h2>
                        <p className="text-xs text-muted-foreground">{t.rich("emailIntro", { bell: () => <IconBell className="inline h-3 w-3" /> })}</p>
                    </div>
                    {savedPrefs && <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><IconCheck className="h-3.5 w-3.5" />{t("saved")}</span>}
                </div>
                {!prefsLoaded && !prefsError && <p role="status" className="mt-4 text-sm text-muted-foreground">{t("loadingPrefs")}</p>}
                {prefsError && <p role="alert" className="mt-4 text-sm text-destructive">{prefsError} {!prefsLoaded && <button type="button" onClick={() => void loadPrefs()} className="min-h-11 px-2 underline">{tc("retry")}</button>}</p>}
                {!emailConfigured && (
                    <p className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                        {t("emailNotConfigured")}
                    </p>
                )}
                <ul className="mt-4 divide-y divide-border">
                    {kinds.map(({ kind, label }) => (
                        <li key={kind} className="flex items-center justify-between gap-3 py-2.5">
                            <span className="text-sm text-foreground">{label}</span>
                            <Toggle
                                label={label}
                                disabled={savingPrefs || !prefsLoaded}
                                checked={emailKinds.includes(kind)}
                                onChange={(on) => void savePrefs(on ? [...emailKinds, kind] : emailKinds.filter((k) => k !== kind))}
                            />
                        </li>
                    ))}
                </ul>
            </article>

            {isAdmin && (
                <article className="emperor-panel rounded-2xl p-4 sm:rounded-2xl sm:p-6">
                    <div className="flex items-center gap-3">
                        <span className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10 text-primary"><IconWebhook className="h-4 w-4" /></span>
                        <div className="min-w-0 flex-1">
                            <h2 className="text-base font-semibold text-foreground">{t("webhookTitle")}</h2>
                            <p className="text-xs text-muted-foreground">{t("webhookIntro")}</p>
                        </div>
                    </div>

                    {!hookLoaded && !hookLoadError && <p role="status" className="mt-4 text-sm text-muted-foreground">{t("loadingWebhook")}</p>}
                    {hookLoadError && <p role="alert" className="mt-4 text-sm text-destructive">{t("webhookLoadFailed")} <button type="button" onClick={() => void loadHook()} className="min-h-11 px-2 underline">{tc("retry")}</button></p>}
                    {!canStoreSecrets && (
                        <p className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                            {t("needsMasterKey")}
                        </p>
                    )}

                    {hook ? (
                        <div className="mt-4 flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                            {hook.format === "slack" ? <IconBrandSlack className="h-4 w-4 text-muted-foreground" /> : hook.format === "discord" ? <IconBrandDiscord className="h-4 w-4 text-muted-foreground" /> : <IconWebhook className="h-4 w-4 text-muted-foreground" />}
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-mono text-xs text-foreground">{hook.urlHint}</div>
                                <div className={cn("text-xs", hook.lastError ? "text-destructive" : "text-muted-foreground")}>
                                    {hook.lastError ? t("lastFailed", { error: hook.lastError }) : hook.lastDeliveryAt ? t("lastDelivered", { when: format.dateTime(new Date(hook.lastDeliveryAt), { dateStyle: "medium", timeStyle: "short" }) }) : t("noDeliveries")}
                                </div>
                            </div>
                            <Toggle label={t("webhookEnabled")} checked={hook.enabled} onChange={(on) => void saveHook({ enabled: on })} disabled={busy || !hookLoaded} />
                        </div>
                    ) : null}

                    <div className="mt-4 flex gap-2">
                        <input
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder={hook ? t("replaceUrl") : WEBHOOK_URL_EXAMPLE}
                            aria-label={t("webhookUrl")}
                            disabled={!canStoreSecrets}
                            className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-muted px-3 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-cyan-400/60 disabled:opacity-50"
                        />
                        <button
                            type="button"
                            onClick={() => void saveHook({ url, kinds: hookKinds })}
                            disabled={busy || !hookLoaded || !url.trim() || !canStoreSecrets}
                            className="rounded-lg bg-cyan-400 px-3 text-sm font-semibold text-cyan-950 hover:bg-cyan-300 disabled:opacity-50"
                        >
                            {tc("save")}
                        </button>
                    </div>

                    <div className="mt-4">
                        <div className="mb-2 text-xs font-medium text-muted-foreground">{t("sendToChannel")}</div>
                        <div className="flex flex-wrap gap-1.5">
                            {allKinds.map((kind) => {
                                const on = hookKinds.includes(kind);
                                return (
                                    <button
                                        key={kind}
                                        type="button"
                                        aria-pressed={on}
                                        disabled={busy || !hookLoaded}
                                        onClick={() => {
                                            const next = on ? hookKinds.filter((k) => k !== kind) : [...hookKinds, kind];
                                            setHookKinds(next);
                                            if (hook) void saveHook({ kinds: next });
                                        }}
                                        className={cn("min-h-11 rounded-full border px-3 py-2 text-xs transition-colors disabled:opacity-50", on ? "border-cyan-400/50 bg-cyan-400/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}
                                    >
                                        {kind in WEBHOOK_KINDS ? t(`webhookKinds.${WEBHOOK_KINDS[kind as keyof typeof WEBHOOK_KINDS]}`) : kind}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {hook && (
                        <div className="mt-4 flex gap-2">
                            <button type="button" onClick={() => void testHook()} disabled={busy || !hookLoaded} className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:border-cyan-400/40 hover:text-primary disabled:opacity-50">{t("sendTest")}</button>
                            <button type="button" onClick={() => void removeHook()} disabled={busy || !hookLoaded} className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-rose-500/10 hover:text-destructive disabled:opacity-50">{tc("remove")}</button>
                        </div>
                    )}
                    {hookMessage && <p role="status" className={cn("mt-3 text-xs", hookMessage.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>{hookMessage.text}</p>}
                </article>
            )}
        </section>
    );
}
