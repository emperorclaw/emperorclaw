"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { IconBell, IconLock, IconSunrise, IconUser, IconUsers } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { SettingsSwitch } from "@/components/ui/settings-switch";
import { cn } from "@/lib/utils";
import type { DirectChatMode } from "@/lib/direct-chat-mode";

/**
 * Setup's optional "How you work" step: four settings, each pre-filled from
 * and saved through the same API the Settings page uses (profile, direct
 * chats, agent routine, notification preferences). A setting this person
 * cannot read or change is left out. Skip saves nothing.
 */

/** Notification kinds behind each email choice (settings.notifications has the full list). */
export const APPROVAL_EMAIL_KINDS = ["approval", "decision"] as const;
export const BLOCKED_EMAIL_KINDS = ["stall", "loop_paused", "agent_failed"] as const;

export type WorkSettings = {
    profile: { displayName: string; roleTitle: string } | null;
    directChatMode: DirectChatMode | null;
    routine: { time: string; timezone: string; configured: boolean } | null;
    email: { configured: boolean; kinds: string[] } | null;
};
export const EMPTY_WORK_SETTINGS: WorkSettings = { profile: null, directChatMode: null, routine: null, email: null };

const getJson = async (url: string) => {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(url);
    return res.json();
};

/** The current values; a setting that does not load (or is admin-only for a non-admin) stays null and is hidden. */
export async function loadWorkSettings(isAdmin: boolean): Promise<WorkSettings> {
    const [profile, chats, routine, prefs] = await Promise.allSettled([
        getJson("/api/user/profile"),
        isAdmin ? getJson("/api/settings/direct-chats") : Promise.reject(new Error("admin only")),
        isAdmin ? getJson("/api/settings/agent-routine") : Promise.reject(new Error("admin only")),
        getJson("/api/notifications/preferences"),
    ]);
    return {
        profile: profile.status === "fulfilled" ? { displayName: profile.value.displayName || "", roleTitle: profile.value.roleTitle || "" } : null,
        directChatMode: chats.status === "fulfilled" ? (chats.value.mode === "shared" ? "shared" : "private") : null,
        routine: routine.status === "fulfilled" && routine.value.routine ? { time: routine.value.routine.time, timezone: routine.value.routine.timezone, configured: Boolean(routine.value.configured) } : null,
        email: prefs.status === "fulfilled" ? { configured: Boolean(prefs.value.emailConfigured), kinds: Array.isArray(prefs.value.emailKinds) ? prefs.value.emailKinds : [] } : null,
    };
}

const browserTimeZone = () => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
};

/**
 * Save what changed, each through its Settings API. ok is false when any save
 * failed (the rest still apply; the person can fix it in Settings). named is
 * true when the person's saved profile has a name (then setup puts them at the
 * top of the org chart).
 */
export async function saveWorkSettings(initial: WorkSettings, next: WorkSettings): Promise<{ ok: boolean; named: boolean }> {
    const send = (url: string, method: string, body: unknown) => fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((res) => { if (!res.ok) throw new Error(url); });
    const jobs: Promise<void>[] = [];
    const profileChanged = Boolean(next.profile && (next.profile.displayName !== initial.profile?.displayName || next.profile.roleTitle !== initial.profile?.roleTitle));
    const profileJob = profileChanged ? send("/api/user/profile", "PATCH", { displayName: next.profile!.displayName.trim(), roleTitle: next.profile!.roleTitle.trim() }) : Promise.resolve();
    jobs.push(profileJob);
    if (next.directChatMode && next.directChatMode !== initial.directChatMode) jobs.push(send("/api/settings/direct-chats", "PUT", { mode: next.directChatMode }));
    if (next.routine && (next.routine.time !== initial.routine?.time || !next.routine.configured)) {
        // A routine never saved runs in the company's own time zone from now on: this browser's.
        jobs.push(send("/api/settings/agent-routine", "PUT", { time: next.routine.time, ...(next.routine.configured ? {} : { timezone: next.routine.timezone }) }));
    }
    if (next.email && next.email.kinds.join() !== initial.email?.kinds.join()) jobs.push(send("/api/notifications/preferences", "PUT", { emailKinds: next.email.kinds }));
    const results = await Promise.allSettled(jobs);
    const profileSaved = results[0].status === "fulfilled";
    return {
        ok: results.every((result) => result.status === "fulfilled"),
        named: profileSaved && Boolean((profileChanged ? next.profile : initial.profile)?.displayName.trim()),
    };
}

/** Pre-fill a routine that was never saved with this browser's time zone. */
export function withLocalTimeZone(settings: WorkSettings): WorkSettings {
    return settings.routine && !settings.routine.configured ? { ...settings, routine: { ...settings.routine, timezone: browserTimeZone() } } : settings;
}

const has = (kinds: string[], group: readonly string[]) => group.every((kind) => kinds.includes(kind));
const toggle = (kinds: string[], group: readonly string[], on: boolean) => on ? [...new Set([...kinds, ...group])] : kinds.filter((kind) => !group.includes(kind));

export function SetupWorkStep({ value, onChange, loading }: { value: WorkSettings; onChange: (next: WorkSettings) => void; loading: boolean }) {
    const t = useTranslations("onboarding.wizard.work");
    const tProfile = useTranslations("settings.profile");
    const tChats = useTranslations("settings.directChats");
    const chatOptions = useMemo(() => [{ mode: "private" as const, icon: IconLock }, { mode: "shared" as const, icon: IconUsers }], []);
    const panel = "rounded-2xl border border-border bg-muted/20 p-4";
    const heading = "flex items-center gap-2 text-sm font-medium text-foreground";

    return (
        <section className="mx-auto max-w-2xl space-y-5">
            <header>
                <h1 id="setup-title" className="text-2xl font-semibold text-foreground">{t("title")}</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("intro")}</p>
            </header>
            {loading && <p role="status" className="text-sm text-muted-foreground">{t("loading")}</p>}

            {value.profile && (
                <div className={panel}>
                    <h2 className={heading}><IconUser className="h-4 w-4 text-primary" aria-hidden />{t("profileTitle")}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">{t("profileHint")}</p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <label className="block">
                            <span className="text-xs font-medium text-foreground">{tProfile("displayName")}</span>
                            <Input value={value.profile.displayName} maxLength={80} placeholder={tProfile("displayNamePlaceholder")} onChange={(e) => onChange({ ...value, profile: { ...value.profile!, displayName: e.target.value } })} className="mt-1 h-11" />
                        </label>
                        <label className="block">
                            <span className="text-xs font-medium text-foreground">{tProfile("roleTitle")}</span>
                            <Input value={value.profile.roleTitle} maxLength={80} placeholder={tProfile("roleTitlePlaceholder")} onChange={(e) => onChange({ ...value, profile: { ...value.profile!, roleTitle: e.target.value } })} className="mt-1 h-11" />
                        </label>
                    </div>
                </div>
            )}

            {value.directChatMode && (
                <div className={panel}>
                    <h2 className={heading}><IconLock className="h-4 w-4 text-primary" aria-hidden />{tChats("title")}</h2>
                    <div role="radiogroup" aria-label={tChats("title")} className="mt-3 grid gap-2 sm:grid-cols-2">
                        {chatOptions.map((option) => {
                            const selected = value.directChatMode === option.mode;
                            const Icon = option.icon;
                            return (
                                <button key={option.mode} type="button" role="radio" aria-checked={selected} onClick={() => onChange({ ...value, directChatMode: option.mode })}
                                    className={cn("flex min-h-11 items-start gap-3 rounded-xl border p-3 text-left transition-colors", selected ? "border-cyan-400/50 bg-cyan-400/10" : "border-border hover:border-input")}>
                                    <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} aria-hidden />
                                    <span className="min-w-0">
                                        <span className="block text-sm font-medium text-foreground">{tChats(option.mode)}</span>
                                        <span className="mt-0.5 block text-xs text-muted-foreground">{tChats(`${option.mode}Description`)}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {value.routine && (
                <div className={panel}>
                    <h2 className={heading}><IconSunrise className="h-4 w-4 text-primary" aria-hidden />{t("reviewTitle")}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">{t("reviewHint")}</p>
                    <label className="mt-3 flex flex-wrap items-center gap-3">
                        <span className="text-xs font-medium text-foreground">{t("reviewTime")}</span>
                        <Input type="time" value={value.routine.time} onChange={(e) => e.target.value && onChange({ ...value, routine: { ...value.routine!, time: e.target.value } })} className="h-11 w-32" />
                        <span className="text-xs text-muted-foreground">{t("timeZone", { zone: value.routine.timezone })}</span>
                    </label>
                </div>
            )}

            {value.email && (
                <div className={panel}>
                    <h2 className={heading}><IconBell className="h-4 w-4 text-primary" aria-hidden />{t("notificationsTitle")}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">{value.email.configured ? t("notificationsHint") : t("emailOff")}</p>
                    {value.email.configured && (
                        <div className="mt-3 space-y-2">
                            {([["emailApprovals", APPROVAL_EMAIL_KINDS], ["emailBlocked", BLOCKED_EMAIL_KINDS]] as const).map(([label, group]) => (
                                <div key={label} className="flex min-h-11 items-center justify-between gap-3">
                                    <span className="text-sm text-foreground">{t(label)}</span>
                                    <SettingsSwitch label={t(label)} checked={has(value.email!.kinds, group)} onChange={(on) => onChange({ ...value, email: { ...value.email!, kinds: toggle(value.email!.kinds, group, on) } })} />
                                </div>
                            ))}
                        </div>
                    )}
                    <Link href="/settings?tab=notifications" target="_blank" className="mt-2 inline-flex min-h-11 items-center text-xs text-cyan-700 hover:underline dark:text-cyan-300">{t("moreInSettings")}</Link>
                </div>
            )}

            <p className="text-xs text-muted-foreground">{t("skipHint")}</p>
        </section>
    );
}
