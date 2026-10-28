"use client";

import { useCallback, useEffect, useState } from "react";
import { IconHandStop } from "@tabler/icons-react";
import { toast } from "sonner";
import {
    ACTION_CATALOG, actionCatalogEntry, resolveActionMode,
    type ActionCatalogEntry, type ActionMode, type ActionPolicyMap,
} from "@/lib/action-policy";
import { cn } from "@/lib/utils";

type Props = { agentId: string; agentName?: string };
type Level = "agent" | "company";

const MODES: { value: ActionMode; label: string; dot: string }[] = [
    { value: "off", label: "Off", dot: "bg-rose-500" },
    { value: "ask", label: "Ask first", dot: "bg-amber-500" },
    { value: "allowed", label: "Allowed", dot: "bg-emerald-500" },
];

const GROUPS: { group: ActionCatalogEntry["group"]; title: string; hint: string }[] = [
    {
        group: "external",
        title: "Outside Emperor",
        hint: "Things the agent does with its own tools. It checks with Emperor before each one (check_action).",
    },
    {
        group: "emperor",
        title: "In Emperor",
        hint: "Emperor's own tools. Reading is always allowed.",
    },
];

/**
 * The agent's action permissions: for each action, Off / Ask first / Allowed.
 * "Ask first" sends every call to the Inbox and the agent waits for the
 * decision. Owners and admins edit; everyone who can see the agent can read.
 * The same list edits the company defaults that every agent starts from.
 */
export function AgentActionsTab({ agentId, agentName }: Props) {
    const [level, setLevel] = useState<Level>("agent");
    const [agentPolicies, setAgentPolicies] = useState<ActionPolicyMap>({});
    const [companyPolicies, setCompanyPolicies] = useState<ActionPolicyMap>({});
    const [canEdit, setCanEdit] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [savingKey, setSavingKey] = useState<string | null>(null);
    const self = agentName || "This agent";

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/agents/${agentId}/action-policies`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Couldn't load permissions"))))
            .then((data) => {
                if (cancelled) return;
                setAgentPolicies(data.agentPolicies ?? {});
                setCompanyPolicies(data.companyPolicies ?? {});
                setCanEdit(Boolean(data.canEdit));
            })
            .catch((error) => { if (!cancelled) toast.error(error instanceof Error ? error.message : "Couldn't load permissions"); })
            .finally(() => { if (!cancelled) setLoaded(true); });
        return () => { cancelled = true; };
    }, [agentId]);

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
            if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Couldn't save the permission");
            if (level === "agent") setAgentPolicies(data.agentPolicies ?? {});
            setCompanyPolicies(data.companyPolicies ?? {});
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Couldn't save the permission");
        } finally {
            setSavingKey(null);
        }
    }, [agentId, level]);

    return (
        <div className="max-w-2xl space-y-5">
            <div className="space-y-2">
                <div className="flex items-center gap-2 text-foreground">
                    <IconHandStop className="h-4 w-4 text-primary" aria-hidden />
                    <h3 className="text-sm font-medium">Actions</h3>
                </div>
                <p className="text-xs text-muted-foreground">
                    Choose what {level === "agent" ? self : "every agent"} may do on its own. <strong className="font-medium text-foreground">Ask first</strong> sends
                    each call to your Inbox and the agent waits; approving lets that exact call run once. <strong className="font-medium text-foreground">Off</strong> refuses it.
                </p>
                <p className="text-xs text-muted-foreground">
                    Only the actions listed here are governed. Anything else an agent can do in Emperor (reading, uploading files,
                    deleting tasks, answering a message it was sent...) is not affected by these settings.
                </p>
            </div>

            <div role="radiogroup" aria-label="Whose permissions" className="inline-flex w-full rounded-lg border border-border bg-muted/50 p-1 sm:w-auto">
                {([
                    { value: "agent", label: self },
                    { value: "company", label: "Company defaults" },
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
                <p className="text-xs text-muted-foreground">Every agent uses these unless its own setting says otherwise.</p>
            )}

            {loaded && !canEdit && (
                <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    Only owners and admins can change permissions.
                </p>
            )}

            {GROUPS.map(({ group, title, hint }) => (
                <section key={group} className="space-y-2" aria-labelledby={`actions-${group}`}>
                    <div>
                        <h4 id={`actions-${group}`} className="text-sm font-medium text-foreground">{title}</h4>
                        <p className="text-xs text-muted-foreground">{hint}</p>
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
    const resolved = level === "agent"
        ? resolveActionMode(entry.key, agentPolicies, companyPolicies)
        : resolveActionMode(entry.key, {}, companyPolicies);
    // Where the value comes from, and whether this level has its own setting to reset.
    const own = level === "agent" ? resolved.source === "agent" : resolved.source === "company";
    const sourceText = own
        ? "Custom"
        : resolved.source === "company" ? "Company default" : "Default";
    const builtIn = actionCatalogEntry(entry.key)?.defaultMode;

    return (
        <li className={cn("flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3", saving && "opacity-70")}>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{entry.label}</p>
                <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                    <code className="font-mono">{entry.key}</code>
                    <span aria-hidden>·</span>
                    <span>{sourceText}</span>
                    {own && !disabled && (
                        <button
                            type="button"
                            onClick={() => onChange(null)}
                            className="text-primary hover:underline"
                            title={level === "agent" ? "Use the company default" : `Use the built-in default (${builtIn === "ask" ? "Ask first" : builtIn === "off" ? "Off" : "Allowed"})`}
                        >
                            Reset
                        </button>
                    )}
                </p>
            </div>
            <div role="radiogroup" aria-label={entry.label} className="inline-flex shrink-0 rounded-lg border border-border bg-muted/50 p-0.5">
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
                            {mode.label}
                        </button>
                    );
                })}
            </div>
        </li>
    );
}
