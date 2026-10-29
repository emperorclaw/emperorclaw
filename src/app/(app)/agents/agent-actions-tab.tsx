"use client";

import { useCallback, useEffect, useState } from "react";
import { IconHandStop } from "@tabler/icons-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
    ACTION_CATALOG, actionCatalogEntry, resolveActionMode,
    type ActionCatalogEntry, type ActionMode, type ActionPolicyMap,
} from "@/lib/action-policy";
import { cn } from "@/lib/utils";

type Props = { agentId: string; agentName?: string };
type Level = "agent" | "company";

/** Labelled by agents.actions.modes.<value>. */
const MODES: { value: ActionMode; dot: string }[] = [
    { value: "off", dot: "bg-rose-500" },
    { value: "ask", dot: "bg-amber-500" },
    { value: "allowed", dot: "bg-emerald-500" },
];

/** Titled by agents.actions.groups.<group>. */
const GROUPS: ActionCatalogEntry["group"][] = ["external", "emperor"];

/** An action's label: agents.actions.catalog.<key>, or the catalog's English label for an unknown key. */
function useActionLabel() {
    const t = useTranslations("agents.actions.catalog");
    return (entry: ActionCatalogEntry) => (t.has(entry.key as "send_email") ? t(entry.key as "send_email") : entry.label);
}

/**
 * The agent's action permissions: for each action, Off / Ask first / Allowed.
 * "Ask first" sends every call to the Inbox and the agent waits for the
 * decision. Owners and admins edit; everyone who can see the agent can read.
 * The same list edits the company defaults that every agent starts from.
 */
export function AgentActionsTab({ agentId, agentName }: Props) {
    const t = useTranslations("agents.actions");
    const [level, setLevel] = useState<Level>("agent");
    const [agentPolicies, setAgentPolicies] = useState<ActionPolicyMap>({});
    const [companyPolicies, setCompanyPolicies] = useState<ActionPolicyMap>({});
    const [canEdit, setCanEdit] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [savingKey, setSavingKey] = useState<string | null>(null);
    const self = agentName || t("thisAgent");

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/agents/${agentId}/action-policies`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(t("loadFailed")))))
            .then((data) => {
                if (cancelled) return;
                setAgentPolicies(data.agentPolicies ?? {});
                setCompanyPolicies(data.companyPolicies ?? {});
                setCanEdit(Boolean(data.canEdit));
            })
            .catch((error) => { if (!cancelled) toast.error(error instanceof Error ? error.message : t("loadFailed")); })
            .finally(() => { if (!cancelled) setLoaded(true); });
        return () => { cancelled = true; };
    }, [agentId, t]);

    const save = useCallback(async (key: string, mode: ActionMode | null) => {
        setSavingKey(key);
        try {
            const url = level === "agent" ? `/api/agents/${agentId}/action-policies` : "/api/action-policies";
            const res = await fetch(url, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ policies: { [key]: mode } }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : t("saveFailed"));
            if (level === "agent") setAgentPolicies(data.agentPolicies ?? {});
            setCompanyPolicies(data.companyPolicies ?? {});
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("saveFailed"));
        } finally {
            setSavingKey(null);
        }
    }, [agentId, level, t]);

    return (
        <div className="max-w-2xl space-y-5">
            <div className="space-y-2">
                <div className="flex items-center gap-2 text-foreground">
                    <IconHandStop className="h-4 w-4 text-primary" aria-hidden />
                    <h3 className="text-sm font-medium">{t("title")}</h3>
                </div>
                <p className="text-xs text-muted-foreground">
                    {t.rich("intro", { who: level === "agent" ? self : t("everyAgent"), strong: (chunks) => <strong className="font-medium text-foreground">{chunks}</strong> })}
                </p>
                <p className="text-xs text-muted-foreground">
                    {t("scopeNote")}
                </p>
            </div>

            <div role="radiogroup" aria-label={t("whose")} className="inline-flex w-full rounded-lg border border-border bg-muted/50 p-1 sm:w-auto">
                {([
                    { value: "agent", label: self },
                    { value: "company", label: t("companyDefaults") },
                ] as const).map((option) => (
                    <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={level === option.value}
                        onClick={() => setLevel(option.value)}
                        className={cn(
                            "min-h-9 flex-1 truncate rounded-md px-4 text-xs font-medium transition sm:flex-none",
                            level === option.value ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {option.label}
                    </button>
                ))}
            </div>
            {level === "company" && (
                <p className="text-xs text-muted-foreground">{t("companyHint")}</p>
            )}

            {loaded && !canEdit && (
                <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {t("adminsOnly")}
                </p>
            )}

            {GROUPS.map((group) => (
                <section key={group} className="space-y-2" aria-labelledby={`actions-${group}`}>
                    <div>
                        <h4 id={`actions-${group}`} className="text-sm font-medium text-foreground">{t(`groups.${group}.title`)}</h4>
                        <p className="text-xs text-muted-foreground">{t(`groups.${group}.hint`)}</p>
                    </div>
                    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                        {ACTION_CATALOG.filter((entry) => entry.group === group).map((entry) => (
                            <ActionRow
                                key={entry.key}
                                entry={entry}
                                level={level}
                                agentPolicies={agentPolicies}
                                companyPolicies={companyPolicies}
                                disabled={!loaded || !canEdit || savingKey !== null}
                                saving={savingKey === entry.key}
                                onChange={(mode) => void save(entry.key, mode)}
                            />
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}

function ActionRow({ entry, level, agentPolicies, companyPolicies, disabled, saving, onChange }: {
    entry: ActionCatalogEntry;
    level: Level;
    agentPolicies: ActionPolicyMap;
    companyPolicies: ActionPolicyMap;
    disabled: boolean;
    saving: boolean;
    onChange: (mode: ActionMode | null) => void;
}) {
    const t = useTranslations("agents.actions");
    const actionLabel = useActionLabel();
    const label = actionLabel(entry);
    const resolved = level === "agent"
        ? resolveActionMode(entry.key, agentPolicies, companyPolicies)
        : resolveActionMode(entry.key, {}, companyPolicies);
    // Where the value comes from, and whether this level has its own setting to reset.
    const own = level === "agent" ? resolved.source === "agent" : resolved.source === "company";
    const sourceText = own
        ? t("source.custom")
        : resolved.source === "company" ? t("source.company") : t("source.default");
    const builtIn = actionCatalogEntry(entry.key)?.defaultMode;

    return (
        <li className={cn("flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3", saving && "opacity-70")}>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{label}</p>
                <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                    <code className="font-mono">{entry.key}</code>
                    <span aria-hidden>·</span>
                    <span>{sourceText}</span>
                    {own && !disabled && (
                        <button
                            type="button"
                            onClick={() => onChange(null)}
                            className="text-primary hover:underline"
                            title={level === "agent" ? t("useCompanyDefault") : t("useBuiltInDefault", { mode: t(`modes.${builtIn === "ask" ? "ask" : builtIn === "off" ? "off" : "allowed"}`) })}
                        >
                            {t("reset")}
                        </button>
                    )}
                </p>
            </div>
            <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-lg border border-border bg-muted/50 p-0.5">
                {MODES.map((mode) => {
                    const checked = resolved.mode === mode.value;
                    return (
                        <button
                            key={mode.value}
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            disabled={disabled}
                            onClick={() => { if (!checked) onChange(mode.value); }}
                            className={cn(
                                "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition",
                                checked ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
                                disabled && "cursor-not-allowed",
                                disabled && !checked && "opacity-60",
                            )}
                        >
                            <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", checked ? mode.dot : "bg-muted-foreground/40")} />
                            {t(`modes.${mode.value}`)}
                        </button>
                    );
                })}
            </div>
        </li>
    );
}
