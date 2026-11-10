"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { sanitizeApproverSetting, type ApproverOptions, type ApproverSetting, type WaitingOn } from "@/lib/approval-routing";

export { sanitizeApproverSetting, type ApproverOptions };

/**
 * "Who approves": Automatic (org chart) / a specific agent / specific people.
 * Used for an agent (its Actions tab) and for a team (Settings → Approvals).
 * Controlled: the parent saves. Owners and admins only; read-only otherwise.
 */
export function ApproverPicker({ id, value, onChange, options, disabled, autoLabel }: {
    id: string;
    value: ApproverSetting;
    onChange: (next: ApproverSetting) => void;
    options: ApproverOptions | null;
    disabled?: boolean;
    /** The "automatic" option's label (an agent follows the org chart; a team falls back to each agent's chain). */
    autoLabel: string;
}) {
    const t = useTranslations("approvers");
    const [filter, setFilter] = useState("");
    const people = useMemo(() => {
        const query = filter.trim().toLowerCase();
        return (options?.people ?? []).filter((person) => !query || person.name.toLowerCase().includes(query));
    }, [options, filter]);
    const agents = options?.agents ?? [];
    const firstAgent = agents[0]?.id ?? "";

    return (
        <div className="grid gap-2">
            <Select id={`${id}-mode`} aria-label={t("modeLabel")} value={value.mode} disabled={disabled}
                onChange={(e) => {
                    const mode = e.target.value;
                    if (mode === "agent") onChange({ mode: "agent", agentId: value.mode === "agent" ? value.agentId : firstAgent });
                    else if (mode === "people") onChange({ mode: "people", userIds: value.mode === "people" ? value.userIds : [] });
                    else onChange({ mode: "auto" });
                }}
                className="h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground">
                <option value="auto">{autoLabel}</option>
                <option value="agent" disabled={agents.length === 0}>{t("modes.agent")}</option>
                <option value="people">{t("modes.people")}</option>
            </Select>
            {value.mode === "agent" && (
                <Select id={`${id}-agent`} aria-label={t("agentLabel")} value={value.agentId} disabled={disabled}
                    onChange={(e) => onChange({ mode: "agent", agentId: e.target.value })}
                    className="h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground">
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </Select>
            )}
            {value.mode === "people" && (
                <div className="grid gap-1.5">
                    <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("findPerson")} aria-label={t("findPerson")} disabled={disabled} />
                    <div className="max-h-48 overflow-y-auto rounded-xl border border-border">
                        {people.length === 0 && <p className="p-3 text-sm text-muted-foreground">{t("nobody")}</p>}
                        <ul className="divide-y divide-border">
                            {people.map((person) => (
                                <li key={person.id}>
                                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-accent/60">
                                        <input type="checkbox" className="h-4 w-4 accent-current" disabled={disabled}
                                            checked={value.userIds.includes(person.id)}
                                            onChange={(e) => onChange({ mode: "people", userIds: e.target.checked ? [...value.userIds, person.id] : value.userIds.filter((userId) => userId !== person.id) })} />
                                        <span className="truncate">{person.name}</span>
                                    </label>
                                </li>
                            ))}
                        </ul>
                    </div>
                    <p className="text-xs text-muted-foreground">{t("anyOne")}</p>
                </div>
            )}
        </div>
    );
}

/** A setting the API accepts (people mode needs someone). */
export function approverSettingComplete(value: ApproverSetting): boolean {
    if (value.mode === "agent") return Boolean(value.agentId);
    if (value.mode === "people") return value.userIds.length > 0;
    return true;
}

/** One step of a chain, in words: "Architect (agent)", "Jose, Luis", "owners and admins". */
export function useWaitingOnLabel() {
    const t = useTranslations("approvers");
    return (step: WaitingOn) => step.kind === "agent" ? t("agentStep", { name: step.names[0] ?? "" }) : step.kind === "users" ? step.names.join(", ") : step.kind === "hidden" ? t("personStep") : t("adminsStep");
}
