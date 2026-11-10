"use client";

import { useCallback, useEffect, useState } from "react";
import { IconCheck } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApproverPicker, approverSettingComplete, sanitizeApproverSetting, type ApproverOptions } from "@/components/approver-picker";
import { DEFAULT_ESCALATE_AFTER_MINUTES, MAX_ESCALATE_AFTER_MINUTES, MIN_ESCALATE_AFTER_MINUTES, type ApproverSetting } from "@/lib/approval-routing";

type Settings = {
    escalateAfterMinutes: number;
    teamApprovers: Record<string, ApproverSetting>;
    teams: { id: string; title: string }[];
    options: ApproverOptions;
    canEdit: boolean;
};

const AUTO: ApproverSetting = { mode: "auto" };

/**
 * Settings → Approvals (approval routing): how long an approver has before an
 * ask moves up the chain, and who approves for each org chart team. Who
 * approves for one agent is on that agent's Actions tab. Owners and admins.
 */
export function ApprovalSettingsTab() {
    const t = useTranslations("settings.approvals");
    const tc = useTranslations("common");
    const [settings, setSettings] = useState<Settings | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [minutes, setMinutes] = useState("");
    const [teams, setTeams] = useState<Record<string, ApproverSetting>>({});
    const [saving, setSaving] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Saved approvers who left (removed people, deleted agents) were dropped from the form.
    const [cleared, setCleared] = useState(false);

    const load = useCallback(async () => {
        setLoadError(false);
        try {
            const res = await fetch("/api/approval-settings");
            if (!res.ok) throw new Error("load");
            const data = (await res.json()) as Settings;
            setSettings(data);
            setMinutes(String(data.escalateAfterMinutes));
            let anyCleared = false;
            const drafts: Record<string, ApproverSetting> = {};
            for (const [teamId, setting] of Object.entries(data.teamApprovers)) {
                const clean = sanitizeApproverSetting(setting, data.options);
                drafts[teamId] = clean.value;
                anyCleared ||= clean.cleared;
            }
            setTeams(drafts);
            setCleared(anyCleared);
        } catch {
            setLoadError(true);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const save = async (key: string, body: Record<string, unknown>) => {
        setSaving(key);
        setSaved(false);
        setError(null);
        try {
            const res = await fetch("/api/approval-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : t("saveFailed"));
            // Only what was saved changes in the form: other teams keep their unsaved edits.
            const next = data as Settings;
            setSettings(next);
            if (key === "minutes") setMinutes(String(next.escalateAfterMinutes));
            else setTeams((prev) => ({ ...prev, [key]: next.teamApprovers[key] ?? AUTO }));
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
        } catch (err) {
            setError(err instanceof Error ? err.message : t("saveFailed"));
        } finally {
            setSaving(null);
        }
    };

    if (loadError && !settings) return <div className="emperor-panel rounded-2xl p-6" role="alert"><p className="text-sm text-destructive">{t("loadFailed")}</p><button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-lg border border-border px-4 text-sm">{tc("retry")}</button></div>;
    if (!settings) return <div className="emperor-panel h-40 animate-pulse rounded-3xl" />;

    const minutesDirty = minutes.trim() !== String(settings.escalateAfterMinutes);
    const disabled = !settings.canEdit || saving !== null;

    return (
        <section className="grid gap-4">
            <article className="emperor-panel rounded-2xl p-4 sm:p-6">
                <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                        <h2 className="text-base font-semibold text-foreground">{t("title")}</h2>
                        <p className="text-xs text-muted-foreground">{t("intro")}</p>
                    </div>
                    {saved && <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><IconCheck className="h-3.5 w-3.5" />{t("saved")}</span>}
                </div>

                <div className="mt-5 grid gap-1.5 sm:max-w-sm">
                    <label htmlFor="approval-escalate-minutes" className="text-sm font-medium text-foreground">{t("escalateLabel")}</label>
                    <div className="flex gap-2">
                        <Input id="approval-escalate-minutes" type="number" inputMode="numeric" min={MIN_ESCALATE_AFTER_MINUTES} max={MAX_ESCALATE_AFTER_MINUTES} step={1}
                            value={minutes} onChange={(e) => setMinutes(e.target.value)} disabled={disabled} className="w-28" />
                        {minutesDirty && settings.canEdit && (
                            <Button type="button" size="sm" disabled={disabled || !minutes.trim()} onClick={() => void save("minutes", { escalateAfterMinutes: Number(minutes) })}>{t("save")}</Button>
                        )}
                    </div>
                    <p className="text-xs text-muted-foreground">{t("escalateHint", { min: MIN_ESCALATE_AFTER_MINUTES, max: MAX_ESCALATE_AFTER_MINUTES, default: DEFAULT_ESCALATE_AFTER_MINUTES })}</p>
                </div>
            </article>

            <article className="emperor-panel rounded-2xl p-4 sm:p-6">
                <h2 className="text-base font-semibold text-foreground">{t("teamsTitle")}</h2>
                <p className="text-xs text-muted-foreground">{t("teamsIntro")}</p>
                {settings.teams.length === 0 ? (
                    <p className="mt-4 text-sm text-muted-foreground">{t("noTeams")}</p>
                ) : (
                    <ul className="mt-4 grid gap-3">
                        {settings.teams.map((team) => {
                            const stored = settings.teamApprovers[team.id] ?? AUTO;
                            const value = teams[team.id] ?? AUTO;
                            const dirty = JSON.stringify(stored) !== JSON.stringify(value);
                            return (
                                <li key={team.id} className="rounded-xl border border-border bg-card p-3">
                                    <p className="mb-2 text-sm font-medium text-foreground">{team.title}</p>
                                    <ApproverPicker id={`team-${team.id}-approvers`} value={value} options={settings.options} disabled={disabled} autoLabel={t("teamAuto")}
                                        onChange={(next) => setTeams((prev) => ({ ...prev, [team.id]: next }))} />
                                    {dirty && settings.canEdit && (
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            <Button type="button" size="sm" disabled={disabled || !approverSettingComplete(value)}
                                                onClick={() => void save(team.id, { teamApprovers: { [team.id]: value.mode === "auto" ? null : value } })}>{t("save")}</Button>
                                            <Button type="button" size="sm" variant="outline" disabled={disabled}
                                                onClick={() => setTeams((prev) => ({ ...prev, [team.id]: stored }))}>{t("cancel")}</Button>
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
                {cleared && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">{t("cleared")}</p>}
                <p className="mt-4 text-xs text-muted-foreground">{t("agentHint")}</p>
            </article>
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </section>
    );
}
