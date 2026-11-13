"use client";

import { useCallback, useEffect, useState } from "react";
import { IconCheck, IconLock, IconUsers } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { DirectChatMode } from "@/lib/direct-chat-mode";
import { MULTI_CHAT_IDLE_DAYS_RANGE, MULTI_CHAT_MAX_OPEN_RANGE, type MultiChatSettings } from "@/lib/multi-chat";
import { SettingsSwitch } from "@/components/ui/settings-switch";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";

/** Idle auto-archive choices in days; a stored value outside the list is offered too. */
const IDLE_DAY_CHOICES = [7, 14, 30, 60, 90] as const;
const NEVER = "never";

/** Labelled by settings.directChats.<mode> and <mode>Description. */
const OPTIONS: { mode: DirectChatMode; icon: typeof IconUsers }[] = [
    { mode: "shared", icon: IconUsers },
    { mode: "private", icon: IconLock },
];

/** Direct chats with agents: shared per agent, or private per person. Owners and admins change it. */
export function DirectChatSettingsTab({ isAdmin }: { isAdmin: boolean }) {
    const t = useTranslations("settings.directChats");
    const tc = useTranslations("common");
    const [mode, setMode] = useState<DirectChatMode | null>(null);
    const [multi, setMulti] = useState<MultiChatSettings | null>(null);
    const [maxOpenDraft, setMaxOpenDraft] = useState("");
    const [loadError, setLoadError] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoadError(false);
        try {
            const res = await fetch("/api/settings/direct-chats");
            if (!res.ok) throw new Error("load");
            const data = await res.json();
            setMode(data.mode === "private" ? "private" : "shared");
            if (typeof data.multiChatEnabled === "boolean") {
                const next = { enabled: data.multiChatEnabled, maxOpen: data.multiChatMaxOpen, idleArchiveDays: data.multiChatIdleArchiveDays ?? null };
                setMulti(next);
                setMaxOpenDraft(String(next.maxOpen));
            }
        } catch {
            setLoadError(true);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const save = async (next: DirectChatMode) => {
        if (!mode || saving || !isAdmin || next === mode) return;
        const previous = mode;
        setSaving(true);
        setSaved(false);
        setError(null);
        setMode(next);
        try {
            const res = await fetch("/api/settings/direct-chats", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: next }) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || t("saveFailed"));
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
        } catch (err) {
            setMode(previous);
            setError(err instanceof Error ? err.message : t("saveFailed"));
        } finally {
            setSaving(false);
        }
    };

    // Multiple chats per agent: each change is saved on its own (admins only).
    const saveMulti = async (patch: Partial<MultiChatSettings>) => {
        if (!multi || saving || !isAdmin) return;
        const previous = multi;
        const next = { ...multi, ...patch };
        setSaving(true);
        setSaved(false);
        setError(null);
        setMulti(next);
        try {
            const body: Record<string, unknown> = {};
            if (patch.enabled !== undefined) body.multiChatEnabled = patch.enabled;
            if (patch.maxOpen !== undefined) body.multiChatMaxOpen = patch.maxOpen;
            if (patch.idleArchiveDays !== undefined) body.multiChatIdleArchiveDays = patch.idleArchiveDays;
            const res = await fetch("/api/settings/direct-chats", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || t("saveFailed"));
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
        } catch (err) {
            setMulti(previous);
            setMaxOpenDraft(String(previous.maxOpen));
            setError(err instanceof Error ? err.message : t("saveFailed"));
        } finally {
            setSaving(false);
        }
    };
    const commitMaxOpen = () => {
        if (!multi) return;
        const value = Number(maxOpenDraft);
        if (!Number.isInteger(value) || value < MULTI_CHAT_MAX_OPEN_RANGE.min || value > MULTI_CHAT_MAX_OPEN_RANGE.max) {
            setMaxOpenDraft(String(multi.maxOpen));
            return;
        }
        if (value !== multi.maxOpen) void saveMulti({ maxOpen: value });
    };
    const idleChoices = multi?.idleArchiveDays && !IDLE_DAY_CHOICES.includes(multi.idleArchiveDays as (typeof IDLE_DAY_CHOICES)[number])
        ? [...IDLE_DAY_CHOICES, multi.idleArchiveDays].sort((a, b) => a - b)
        : [...IDLE_DAY_CHOICES];

    if (loadError && !mode) return <div className="emperor-panel rounded-2xl p-6" role="alert"><p className="text-sm text-destructive">{t("loadFailed")}</p><button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-lg border border-border px-4 text-sm">{tc("retry")}</button></div>;
    if (!mode) return <div className="emperor-panel h-40 animate-pulse rounded-3xl" />;

    return (
        <section className="grid gap-4">
            <article className="emperor-panel rounded-2xl p-4 sm:rounded-2xl sm:p-6">
                <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                        <h2 className="text-base font-semibold text-foreground">{t("title")}</h2>
                        <p className="text-xs text-muted-foreground">{t("intro")}</p>
                    </div>
                    {saved && <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><IconCheck className="h-3.5 w-3.5" />{t("saved")}</span>}
                </div>

                <div role="radiogroup" aria-label={t("title")} className="mt-5 grid gap-3 sm:grid-cols-2">
                    {OPTIONS.map((option) => {
                        const selected = option.mode === mode;
                        const Icon = option.icon;
                        return (
                            <button
                                key={option.mode}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                disabled={!isAdmin || saving}
                                onClick={() => void save(option.mode)}
                                className={cn(
                                    "flex min-h-11 items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 disabled:cursor-not-allowed",
                                    selected ? "border-cyan-400/40 bg-cyan-400/10" : "border-border hover:border-cyan-400/30",
                                    !isAdmin && !selected && "opacity-60",
                                )}
                            >
                                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />
                                <span className="min-w-0">
                                    <span className="block text-sm font-medium text-foreground">{t(option.mode)}</span>
                                    <span className="mt-1 block text-xs text-muted-foreground">{t(`${option.mode}Description`)}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>

                <p className="mt-4 text-xs text-muted-foreground">
                    {t("switchNote")}
                    {!isAdmin && ` ${t("adminsOnly")}`}
                </p>
                {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
            </article>

            {multi && (
                <article className="emperor-panel rounded-2xl p-4 sm:rounded-2xl sm:p-6" aria-labelledby="multi-chat-title">
                    <h2 id="multi-chat-title" className="text-base font-semibold text-foreground">{t("multiChat.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("multiChat.intro")}</p>

                    <div className="mt-4 flex items-center gap-3 rounded-xl border border-border p-3">
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-foreground">{t("multiChat.enabledLabel")}</span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">{t("multiChat.enabledDescription")}</span>
                        </span>
                        <SettingsSwitch checked={multi.enabled} onChange={(enabled) => void saveMulti({ enabled })} label={t("multiChat.enabledLabel")} disabled={!isAdmin || saving} />
                    </div>
                    {!multi.enabled && <p className="mt-2 text-xs text-muted-foreground">{t("multiChat.offNote")}</p>}

                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                        <label className="grid gap-1.5">
                            <span className="text-sm font-medium text-foreground">{t("multiChat.maxOpenLabel")}</span>
                            <Input
                                type="number"
                                inputMode="numeric"
                                min={MULTI_CHAT_MAX_OPEN_RANGE.min}
                                max={MULTI_CHAT_MAX_OPEN_RANGE.max}
                                step={1}
                                value={maxOpenDraft}
                                disabled={!isAdmin || saving}
                                onChange={(event) => setMaxOpenDraft(event.target.value)}
                                onBlur={commitMaxOpen}
                                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitMaxOpen(); } }}
                                aria-describedby="multi-chat-max-hint"
                                className="h-11 max-w-32"
                            />
                            <span id="multi-chat-max-hint" className="text-xs text-muted-foreground">{t("multiChat.maxOpenHint", MULTI_CHAT_MAX_OPEN_RANGE)}</span>
                        </label>
                        <div className="grid content-start gap-1.5">
                            <span id="multi-chat-idle-label" className="text-sm font-medium text-foreground">{t("multiChat.idleLabel")}</span>
                            <Select
                                aria-labelledby="multi-chat-idle-label"
                                aria-describedby="multi-chat-idle-hint"
                                value={multi.idleArchiveDays === null ? NEVER : String(multi.idleArchiveDays)}
                                disabled={!isAdmin || saving}
                                onChange={(event) => void saveMulti({ idleArchiveDays: event.target.value === NEVER ? null : Number(event.target.value) })}
                                className="h-11 w-full max-w-48"
                            >
                                {idleChoices.filter((days) => days >= MULTI_CHAT_IDLE_DAYS_RANGE.min && days <= MULTI_CHAT_IDLE_DAYS_RANGE.max).map((days) => (
                                    <option key={days} value={String(days)}>{t("multiChat.idleDays", { count: days })}</option>
                                ))}
                                <option value={NEVER}>{t("multiChat.idleNever")}</option>
                            </Select>
                            <span id="multi-chat-idle-hint" className="text-xs text-muted-foreground">{t("multiChat.idleHint")}</span>
                        </div>
                    </div>

                    <p className="mt-4 text-xs text-muted-foreground">
                        {mode === "shared" && `${t("multiChat.sharedNote")} `}
                        {multi.enabled && t("multiChat.offNote")}
                        {!isAdmin && ` ${t("adminsOnly")}`}
                    </p>
                </article>
            )}
        </section>
    );
}
