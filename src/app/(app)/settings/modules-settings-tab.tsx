"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { IconCheck } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { SettingsSwitch } from "@/components/ui/settings-switch";
import { COMPANY_TEMPLATES, MODULES, templateModules, type CompanyTemplateId, type ModuleKey, type ModuleState } from "@/lib/modules";
import { cn } from "@/lib/utils";

/** "Turns off Customers and Views. Turns on Costs." for the confirm step. */
function templateChange(modules: ModuleState, id: CompanyTemplateId, t: ReturnType<typeof useTranslations<"settings.modules">>): string {
    const next = templateModules(id);
    const list = (keys: ModuleKey[]) => keys.map((key) => t(`items.${key}.label`)).join(", ");
    const off = MODULES.filter((m) => modules[m.key] && !next[m.key]).map((m) => m.key);
    const on = MODULES.filter((m) => !modules[m.key] && next[m.key]).map((m) => m.key);
    return [off.length ? t("turnsOff", { modules: list(off) }) : "", on.length ? t("turnsOn", { modules: list(on) }) : ""].filter(Boolean).join(" ");
}

/**
 * Settings → Modules: switch parts of Emperor on and off for the company.
 * Owners and admins change it; a module's data is kept while it is off.
 */
export function ModulesSettingsTab({ isAdmin }: { isAdmin: boolean }) {
    const t = useTranslations("settings.modules");
    const tc = useTranslations("common");
    const router = useRouter();
    const [modules, setModules] = useState<ModuleState | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [saving, setSaving] = useState<ModuleKey | "template" | null>(null);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmTemplate, setConfirmTemplate] = useState<CompanyTemplateId | null>(null);

    const load = useCallback(async () => {
        setLoadError(false);
        try {
            const res = await fetch("/api/settings/modules", { cache: "no-store" });
            if (!res.ok) throw new Error("load");
            setModules((await res.json()).modules);
        } catch {
            setLoadError(true);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const save = async (body: { modules: Partial<ModuleState> } | { template: CompanyTemplateId }, busy: ModuleKey | "template") => {
        if (!modules || saving || !isAdmin) return;
        const previous = modules;
        setSaving(busy);
        setSaved(false);
        setError(null);
        setModules("template" in body ? templateModules(body.template) : { ...modules, ...body.modules });
        try {
            const res = await fetch("/api/settings/modules", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || t("saveFailed"));
            setModules(data.modules);
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
            // The sidebar and pages read modules on the server.
            router.refresh();
        } catch (err) {
            setModules(previous);
            setError(err instanceof Error ? err.message : t("saveFailed"));
        } finally {
            setSaving(null);
            setConfirmTemplate(null);
        }
    };

    if (loadError && !modules) return <div className="emperor-panel rounded-2xl p-6" role="alert"><p className="text-sm text-destructive">{t("loadFailed")}</p><button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-lg border border-border px-4 text-sm">{tc("retry")}</button></div>;
    if (!modules) return <div className="emperor-panel h-40 animate-pulse rounded-3xl" />;

    const matching = COMPANY_TEMPLATES.find((template) => MODULES.every((m) => templateModules(template.id)[m.key] === modules[m.key]))?.id ?? null;

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

                <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
                    {MODULES.map((m) => (
                        <li key={m.key} className="flex items-center gap-3 px-4 py-2">
                            <div className="min-w-0 flex-1 py-1">
                                <p className="text-sm font-medium text-foreground">{t(`items.${m.key}.label`)}</p>
                                <p className="text-xs text-muted-foreground">{t(`items.${m.key}.description`)}</p>
                            </div>
                            <SettingsSwitch
                                checked={modules[m.key]}
                                label={t("moduleSwitch", { module: t(`items.${m.key}.label`) })}
                                disabled={!isAdmin || saving !== null}
                                onChange={(next) => void save({ modules: { [m.key]: next } }, m.key)}
                            />
                        </li>
                    ))}
                </ul>
                {!isAdmin && <p className="mt-3 text-xs text-muted-foreground">{t("adminsOnly")}</p>}
                {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
            </article>

            {isAdmin && (
                <article className="emperor-panel rounded-2xl p-4 sm:p-6">
                    <h2 className="text-base font-semibold text-foreground">{t("templatesTitle")}</h2>
                    <p className="text-xs text-muted-foreground">{t("templatesIntro")}</p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        {COMPANY_TEMPLATES.map((template) => {
                            const current = matching === template.id;
                            const confirming = confirmTemplate === template.id;
                            const label = t(`templates.${template.id}.label`);
                            return (
                                <div key={template.id} className={cn("flex flex-col rounded-xl border p-4", current ? "border-primary/40 bg-primary/5" : "border-border")}>
                                    <p className="text-sm font-medium text-foreground">{label}</p>
                                    <p className="mt-1 flex-1 text-xs text-muted-foreground">{t(`templates.${template.id}.description`)}</p>
                                    {current ? (
                                        <p className="mt-3 inline-flex min-h-11 items-center gap-1 text-xs text-muted-foreground"><IconCheck className="h-3.5 w-3.5" />{t("matches")}</p>
                                    ) : confirming ? (
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            <p className="w-full text-xs text-foreground">{templateChange(modules, template.id, t)}</p>
                                            <Button size="sm" onClick={() => void save({ template: template.id }, "template")} disabled={saving !== null}>{t("apply", { template: label })}</Button>
                                            <Button size="sm" variant="ghost" onClick={() => setConfirmTemplate(null)} disabled={saving !== null}>{tc("cancel")}</Button>
                                        </div>
                                    ) : (
                                        <Button size="sm" variant="outline" className="mt-3 self-start" onClick={() => setConfirmTemplate(template.id)} disabled={saving !== null}>{t("useTemplate")}</Button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </article>
            )}
        </section>
    );
}
