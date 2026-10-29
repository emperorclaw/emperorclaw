"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { IconLanguage, IconUsers } from "@tabler/icons-react";
import type { Locale } from "@/i18n/config";

/** Settings → Your profile: name, role and the person's language. */
export function ProfileTab({ displayName, setDisplayName, roleTitle, setRoleTitle, onSave, saving, onLoad, loaded, error, onRetry, locale, onLocaleChange }: {
    displayName: string;
    setDisplayName: (v: string) => void;
    roleTitle: string;
    setRoleTitle: (v: string) => void;
    onSave: () => void;
    saving: boolean;
    onLoad: () => void;
    loaded: boolean;
    error: boolean;
    onRetry: () => void;
    /** The saved preference: a locale, or null for "Automatic". */
    locale: Locale | null;
    onLocaleChange: (locale: Locale | null) => void;
}) {
    const t = useTranslations("settings.profile");
    useEffect(() => { if (!loaded) onLoad(); }, [loaded, onLoad]);
    return (
        <div className="space-y-5">
            <section className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6 max-w-lg">
                <h2 className="flex items-center text-lg font-semibold text-foreground mb-4">
                    <IconUsers className="mr-2 h-5 w-5 text-primary" /> {t("title")}
                </h2>
                <p className="text-sm text-muted-foreground mb-6">{t("intro")}</p>
                {error && <p role="alert" className="mb-4 text-sm text-destructive">{t("loadError")} <button type="button" onClick={onRetry} className="min-h-11 underline">{t("retry")}</button></p>}
                {!loaded && !error && <p role="status" className="mb-4 text-sm text-muted-foreground">{t("loading")}</p>}
                <div className="space-y-4">
                    <label className="block">
                        <span className="text-sm font-medium text-foreground">{t("displayName")}</span>
                        <input disabled={!loaded} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t("displayNamePlaceholder")} className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-cyan-400" />
                    </label>
                    <label className="block">
                        <span className="text-sm font-medium text-foreground">{t("roleTitle")}</span>
                        <input disabled={!loaded} value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} placeholder={t("roleTitlePlaceholder")} className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-cyan-400" />
                        <p className="mt-1 text-xs text-muted-foreground">{t("roleTitleHint")}</p>
                    </label>
                    <button onClick={onSave} disabled={saving || !loaded} className="min-h-11 cursor-pointer rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                        {saving ? t("saving") : t("save")}
                    </button>
                </div>
            </section>
            <LanguageSetting locale={locale} disabled={!loaded} onChange={onLocaleChange} />
        </div>
    );
}

const AUTOMATIC = "auto";

/**
 * The person's language: English, Simplified Chinese, or Automatic (the
 * browser's language). Saved on the account (users.locale) and mirrored in
 * the NEXT_LOCALE cookie by the API, then the page re-renders in place.
 */
function LanguageSetting({ locale, disabled, onChange }: { locale: Locale | null; disabled: boolean; onChange: (locale: Locale | null) => void }) {
    const t = useTranslations("settings.language");
    const tNames = useTranslations("settings.languageNames");
    const router = useRouter();
    const [saving, setSaving] = useState(false);

    const save = async (value: string) => {
        const next = value === AUTOMATIC ? null : (value as Locale);
        setSaving(true);
        try {
            const res = await fetch("/api/user/profile", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ locale: next }),
            });
            if (!res.ok) throw new Error("locale");
            onChange(next);
            router.refresh();
            toast.success(t("saved"));
        } catch {
            toast.error(t("saveFailed"));
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="emperor-panel max-w-lg rounded-2xl p-4 sm:p-6">
            <h2 className="mb-2 flex items-center text-lg font-semibold text-foreground">
                <IconLanguage className="mr-2 h-5 w-5 text-primary" aria-hidden /> {t("title")}
            </h2>
            <p className="mb-4 text-sm text-muted-foreground">{t("description")}</p>
            <label className="block">
                <span className="text-sm font-medium text-foreground">{t("label")}</span>
                <select
                    value={locale ?? AUTOMATIC}
                    disabled={disabled || saving}
                    onChange={(event) => void save(event.target.value)}
                    className="mt-1 min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-ring disabled:opacity-50"
                >
                    <option value={AUTOMATIC}>{t("automatic")}</option>
                    <option value="en" lang="en">{tNames("en")}</option>
                    <option value="zh-CN" lang="zh-CN">{tNames("zhCN")}</option>
                </select>
            </label>
        </section>
    );
}
