"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { IconBook, IconCheck, IconSend, IconSunrise } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { SettingsSwitch as Toggle } from "@/components/ui/settings-switch";

type Routine = { enabled: boolean; stallRemindersEnabled: boolean; time: string; timezone: string; weekdaysOnly: boolean };


/**
 * The daily agent review: when it runs, in which timezone, and on which days.
 * Everyone can see it; admins change it.
 */
export function RoutineSettingsTab({ isAdmin }: { isAdmin: boolean }) {
    const t = useTranslations("settings.routines");
    const tc = useTranslations("common");
    const [routine, setRoutine] = useState<Routine | null>(null);
    const [configured, setConfigured] = useState(true);
    const [lastRunOn, setLastRunOn] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [saving, setSaving] = useState(false);
    const [loadError, setLoadError] = useState(false);

    const timezones = useMemo(() => {
        try {
            return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"];
        } catch {
            return ["UTC"];
        }
    }, []);
    const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);

    const loadRoutine = useCallback(async () => {
        setLoadError(false);
        try {
            const res = await fetch("/api/settings/agent-routine");
            if (!res.ok) throw new Error("load");
            const data = await res.json();
            setRoutine(data.routine);
            setConfigured(data.configured);
            setLastRunOn(data.lastRunOn);
        } catch {
            setLoadError(true);
        }
    }, []);
    useEffect(() => { void loadRoutine(); }, [loadRoutine]);

    const save = async (patch: Partial<Routine>) => {
        if (!routine || saving || !isAdmin) return;
        const previous = routine;
        const next = { ...routine, ...patch };
        setSaving(true);
        setSaved(false);
        setMessage(null);
        setRoutine(next);
        try {
            const res = await fetch("/api/settings/agent-routine", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || t("saveFailed"));
            setConfigured(true);
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
        } catch (error) {
            setRoutine(previous);
            setMessage({ ok: false, text: error instanceof Error ? error.message : t("saveFailed") });
        } finally {
            setSaving(false);
        }
    };

    const runNow = async () => {
        setBusy(true);
        setMessage(null);
        try {
        const res = await fetch("/api/settings/agent-routine", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        setMessage(res.ok
            ? { ok: true, text: data.agentsReviewed ? t("reviewSent", { count: data.agentsReviewed }) : t("reviewNothing") }
            : { ok: false, text: data.error || t("reviewRejected") });
        } catch {
            setMessage({ ok: false, text: t("reviewFailed") });
        } finally {
            setBusy(false);
        }
    };

    const [doctrineBusy, setDoctrineBusy] = useState(false);
    const [doctrineMessage, setDoctrineMessage] = useState<{ ok: boolean; text: string } | null>(null);
    const runDoctrineUpgrade = async () => {
        setDoctrineBusy(true);
        setDoctrineMessage(null);
        try {
        const res = await fetch("/api/settings/starter-doctrine", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        setDoctrineMessage(res.ok
            ? { ok: true, text: t("doctrineUpdated", { updated: data.updated, created: data.created, suggestions: data.suggestions }) }
            : { ok: false, text: data.error || t("doctrineRejected") });
        } catch {
            setDoctrineMessage({ ok: false, text: t("doctrineFailed") });
        } finally {
            setDoctrineBusy(false);
        }
    };

    if (loadError && !routine) return <div className="emperor-panel rounded-2xl p-6" role="alert"><p className="text-sm text-destructive">{t("loadFailed")}</p><button type="button" onClick={() => void loadRoutine()} className="mt-3 min-h-11 rounded-lg border border-border px-4 text-sm">{tc("retry")}</button></div>;
    if (!routine) return <div className="emperor-panel h-40 animate-pulse rounded-3xl" />;
    const disabled = !isAdmin || saving;

    return (
        <section className="grid gap-4 lg:grid-cols-2">
            <article className="emperor-panel rounded-2xl p-4 sm:rounded-2xl sm:p-6">
                <div className="flex items-center gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10 text-primary"><IconSunrise className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-base font-semibold text-foreground">{t("dailyTitle")}</h2>
                        <p className="text-xs text-muted-foreground">{t("dailyIntro")}</p>
                    </div>
                    {saved && <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><IconCheck className="h-3.5 w-3.5" />{t("saved")}</span>}
                    <Toggle label={t("dailyReview")} checked={routine.enabled} onChange={(on) => void save({ enabled: on })} disabled={disabled} />
                </div>

                <div className={cn("mt-5 grid gap-3 sm:grid-cols-2", !routine.enabled && "opacity-50")}>
                    <label className="block">
                        <span className="text-xs font-medium text-muted-foreground">{t("time")}</span>
                        <input type="time" value={routine.time} disabled={disabled || !routine.enabled}
                            onChange={(e) => e.target.value && void save({ time: e.target.value })}
                            className="mt-1 h-10 w-full rounded-lg border border-border bg-muted px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-400/60" />
                    </label>
                    <label className="block">
                        <span className="text-xs font-medium text-muted-foreground">{t("timezone")}</span>
                        <select value={routine.timezone} disabled={disabled || !routine.enabled}
                            onChange={(e) => void save({ timezone: e.target.value })}
                            className="mt-1 h-10 w-full rounded-lg border border-border bg-muted px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-400/60">
                            {[...new Set([routine.timezone, ...timezones])].map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                        </select>
                    </label>
                </div>
                {isAdmin && !configured && routine.timezone !== browserZone && (
                    <button type="button" onClick={() => void save({ timezone: browserZone })} className="mt-2 text-xs text-primary hover:text-cyan-200">
                        {t("useMyTimezone", { zone: browserZone })}
                    </button>
                )}
                <div className={cn("mt-4 flex items-center justify-between gap-3 border-t border-border/80 pt-4", !routine.enabled && "opacity-50")}>
                    <span className="text-sm text-foreground">{t("weekdaysOnly")}</span>
                    <Toggle label={t("weekdaysOnly")} checked={routine.weekdaysOnly} onChange={(on) => void save({ weekdaysOnly: on })} disabled={disabled || !routine.enabled} />
                </div>
                <p className="mt-4 text-xs text-muted-foreground">
                    {lastRunOn ? `${t("lastSent", { date: lastRunOn })} ` : ""}{t("idleNote")}
                    {!isAdmin && ` ${t("adminsOnly")}`}
                </p>
            </article>

            <article className="emperor-panel rounded-2xl p-4 sm:rounded-2xl sm:p-6">
                <div className="flex items-center justify-between gap-4"><h2 className="text-base font-semibold text-foreground">{t("stallTitle")}</h2><Toggle label={t("stallTitle")} checked={routine.stallRemindersEnabled} onChange={(on) => void save({ stallRemindersEnabled: on })} disabled={disabled} /></div>
                <p className="mt-3 text-sm text-muted-foreground">{t("stallBody")}</p>
                <p className="mt-3 text-xs text-muted-foreground">{t("stallOffNote")}</p>
            </article>
            <article className="emperor-panel rounded-2xl p-4 sm:rounded-2xl sm:p-6">
                <h2 className="text-base font-semibold text-foreground">{t("whatTitle")}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{t("whatIntro")}</p>
                <ul className="mt-3 space-y-1.5 text-sm text-foreground">
                    {(["openTasks", "moveForward", "noteProgress", "closeWhenMet", "askQuestion", "replySummary"] as const).map((key) => <li key={key}>{"• "}{t(`what.${key}`)}</li>)}
                </ul>
                {isAdmin && (
                    <button type="button" onClick={() => void runNow()} disabled={busy}
                        className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:border-cyan-400/40 hover:text-primary disabled:opacity-50">
                        <IconSend className="h-3.5 w-3.5" />{t("sendNow")}
                    </button>
                )}
                {message && <p role="status" className={cn("mt-3 text-xs", message.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>{message.text}</p>}
            </article>

            {isAdmin && (
                <article className="emperor-panel rounded-2xl p-4 sm:rounded-2xl sm:p-6">
                    <div className="flex items-center gap-3">
                        <span className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10 text-primary"><IconBook className="h-4 w-4" /></span>
                        <div className="min-w-0 flex-1">
                            <h2 className="text-base font-semibold text-foreground">{t("doctrineTitle")}</h2>
                            <p className="text-xs text-muted-foreground">{t("doctrineIntro")}</p>
                        </div>
                    </div>
                    <p className="mt-3 text-sm text-foreground">
                        {t("doctrineBody")}
                    </p>
                    <button type="button" onClick={() => void runDoctrineUpgrade()} disabled={doctrineBusy}
                        className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:border-cyan-400/40 hover:text-primary disabled:opacity-50">
                        <IconSend className="h-3.5 w-3.5" />{t("doctrineButton")}
                    </button>
                    {doctrineMessage && <p role="status" className={cn("mt-3 text-xs", doctrineMessage.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>{doctrineMessage.text}</p>}
                </article>
            )}
        </section>
    );
}
