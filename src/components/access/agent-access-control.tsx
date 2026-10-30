"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useApiError } from "@/lib/i18n/use-api-error";
import { IconLock } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PersonChip } from "@/components/views/view-meta";
import { normalizeAgentAccess, type AgentAccessMode } from "@/lib/agent-access";
import { cn } from "@/lib/utils";

type Named = { id: string; name: string };

/** What "Who can use it" holds: the mode, the people ('people') and the owner. */
export type AgentAccessValue = { access: AgentAccessMode; userIds: string[]; ownerUserId: string | null };

export const EVERYONE_ACCESS: AgentAccessValue = { access: "everyone", userIds: [], ownerUserId: null };

const OPTIONS: AgentAccessMode[] = ["everyone", "people", "owner"];

/** "Everyone", "Only Ana", "Ana + 2 people" (lib/agent-access.ts agentAccessSummary, translated). */
export function useAgentAccessSummary() {
    const t = useTranslations("access.agent");
    return (agent: { access: string; ownerName: string | null; peopleCount: number }): string => {
        const owner = agent.ownerName ?? t("itsOwner");
        const mode = normalizeAgentAccess(agent.access);
        if (mode === "everyone") return t("summaryEveryone");
        if (mode === "owner" || agent.peopleCount === 0) return t("summaryOnly", { owner });
        return t("summaryPeople", { owner, count: agent.peopleCount });
    };
}

async function errorOf(res: Response, fallback: string): Promise<string> {
    const data = await res.json().catch(() => ({})) as { error?: string };
    return data.error || fallback;
}

/** The request fields the hire routes read (POST /api/agents, /api/agents/easy-setup). */
export function hireAccessBody(value: AgentAccessValue): Record<string, unknown> {
    if (value.access === "everyone") return {};
    return { access: value.access, accessUserIds: value.userIds, ownerUserId: value.ownerUserId ?? undefined };
}

/** The lock badge on a limited agent: "Only Ana", "Ana + 2 people". */
export function AgentLockBadge({ access, ownerName, peopleCount = 0, className }: { access: string; ownerName: string | null; peopleCount?: number; className?: string }) {
    const t = useTranslations("access.agent");
    const summarize = useAgentAccessSummary();
    if (access === "everyone") return null;
    const text = summarize({ access, ownerName, peopleCount });
    return (
        <span title={t("badgeTitle", { summary: text })} className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground", className)}>
            <IconLock className="h-3 w-3" aria-hidden />{ownerName ?? t("limited")}
        </span>
    );
}

/**
 * "Who can use it": Everyone (default) / Specific people / Only one person
 * (me, or someone I pick). Used by the hire dialogs and the agent's settings.
 */
export function WhoCanUseField({ value, onChange, people, me, disabled }: {
    value: AgentAccessValue;
    onChange: (next: AgentAccessValue) => void;
    people: Named[];
    me: string | null;
    disabled?: boolean;
}) {
    const t = useTranslations("access.agent");
    const [filter, setFilter] = useState("");
    const owner = value.ownerUserId ?? me;
    const shown = people.filter((p) => p.id !== owner && p.name.toLowerCase().includes(filter.trim().toLowerCase()));
    return (
        <fieldset className="grid gap-2" disabled={disabled}>
            <legend className="mb-1 text-sm font-medium text-foreground">{t("whoCanUse")}</legend>
            <div role="radiogroup" aria-label={t("whoCanUse")} className="grid grid-cols-3 gap-1 rounded-xl border border-border bg-background p-1">
                {OPTIONS.map((option) => (
                    <button key={option} type="button" role="radio" aria-checked={value.access === option}
                        onClick={() => onChange({ ...value, access: option, ownerUserId: option === "everyone" ? value.ownerUserId : owner ?? people[0]?.id ?? null })}
                        className={cn("whitespace-nowrap rounded-lg px-2 py-1.5 text-xs transition-colors sm:text-sm",
                            value.access === option ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
                        {t(`options.${option}`)}
                    </button>
                ))}
            </div>
            {value.access === "everyone" && <p className="text-xs text-muted-foreground">{t("everyoneHint")}</p>}
            {value.access !== "everyone" && (
                <div className="grid gap-1.5">
                    <label className="text-xs text-muted-foreground" htmlFor="agent-access-owner">{t("owner")}</label>
                    <select id="agent-access-owner" value={owner ?? ""} onChange={(e) => onChange({ ...value, ownerUserId: e.target.value || null })}
                        className="h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground">
                        {people.map((p) => <option key={p.id} value={p.id}>{p.id === me ? t("me", { name: p.name }) : p.name}</option>)}
                    </select>
                    <p className="text-xs text-muted-foreground">
                        {value.access === "owner"
                            ? t("ownerHint")
                            : t("peopleHint")}
                    </p>
                </div>
            )}
            {value.access === "people" && (
                <div className="grid gap-1.5">
                    <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("findPerson")} aria-label={t("findPerson")} />
                    <div className="max-h-48 overflow-y-auto rounded-xl border border-border">
                        {shown.length === 0 && <p className="p-3 text-sm text-muted-foreground">{t("nobodyElse")}</p>}
                        <ul className="divide-y divide-border">
                            {shown.map((person) => (
                                <li key={person.id}>
                                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-accent/60">
                                        <input type="checkbox" checked={value.userIds.includes(person.id)} className="h-4 w-4 accent-current"
                                            onChange={(e) => onChange({ ...value, userIds: e.target.checked ? [...value.userIds, person.id] : value.userIds.filter((id) => id !== person.id) })} />
                                        <PersonChip name={person.name} className="text-sm text-foreground" />
                                    </label>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            )}
        </fieldset>
    );
}

/** People for the hire dialog's field, loaded once it opens. */
export function useAccessPeople(enabled: boolean): { people: Named[]; me: string | null } {
    const [state, setState] = useState<{ people: Named[]; me: string | null }>({ people: [], me: null });
    useEffect(() => {
        if (!enabled) return;
        let alive = true;
        fetch("/api/agents/access-people").then(async (res) => {
            if (!res.ok) return;
            const data = await res.json() as { people: Named[]; me: string };
            if (alive) setState({ people: data.people, me: data.me });
        }).catch(() => {});
        return () => { alive = false; };
    }, [enabled]);
    return state;
}

type AccessInfo = {
    access: AgentAccessMode;
    owner: Named | null;
    people: Named[];
    use: "full" | "metadata";
    canManage: boolean;
    candidates: Named[];
};

/** The agent settings' "Who can use it" (its owner, owners and admins change it; others read it). */
export function AgentAccessSettings({ agentId, onChanged }: { agentId: string; onChanged?: () => void }) {
    const t = useTranslations("access.agent");
    const apiError = useApiError();
    const tc = useTranslations("common");
    const summarize = useAgentAccessSummary();
    const [info, setInfo] = useState<AccessInfo | null>(null);
    const [draft, setDraft] = useState<AgentAccessValue | null>(null);
    const [saving, setSaving] = useState(false);
    const load = async () => {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/access`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json() as AccessInfo;
        setInfo(data);
        setDraft({ access: data.access, userIds: data.people.map((p) => p.id), ownerUserId: data.owner?.id ?? null });
    };
    useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agentId]);
    if (!info || !draft) return null;
    const summary = summarize({ access: info.access, ownerName: info.owner?.name ?? null, peopleCount: info.people.length });
    if (!info.canManage) {
        return (
            <section className="rounded-2xl border border-border bg-card p-3">
                <h3 className="text-sm font-medium text-foreground">{t("whoCanUse")}</h3>
                <p className="text-xs text-muted-foreground">{summary}{info.people.length > 0 && info.access === "people" ? `: ${[info.owner?.name, ...info.people.map((p) => p.name)].filter(Boolean).join(", ")}` : ""}</p>
            </section>
        );
    }
    const dirty = draft.access !== info.access || (draft.ownerUserId ?? null) !== (info.owner?.id ?? null)
        || [...draft.userIds].sort().join() !== info.people.map((p) => p.id).sort().join();
    const save = async () => {
        setSaving(true);
        try {
            const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/access`, {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ access: draft.access, userIds: draft.userIds, ownerUserId: draft.ownerUserId }),
            });
            if (!res.ok) throw new Error(await errorOf(res, t("saveFailed")));
            toast.success(t("saved"));
            await load();
            onChanged?.();
        } catch (error) {
            toast.error(apiError(error instanceof Error ? error.message : null, t("saveFailed")));
        } finally {
            setSaving(false);
        }
    };
    return (
        <section className="grid gap-3 rounded-2xl border border-border bg-card p-3">
            <WhoCanUseField value={draft} onChange={setDraft} people={info.candidates} me={null} disabled={saving} />
            <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => setDraft({ access: info.access, userIds: info.people.map((p) => p.id), ownerUserId: info.owner?.id ?? null })}>{tc("reset")}</Button>
                <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? tc("saving") : tc("save")}</Button>
            </div>
        </section>
    );
}

/**
 * An agent an owner/admin may not use (lib/agent-access.ts "metadata"): its
 * name, owner, status and cost, and the controls to change who can use it,
 * hand it over or delete it. Never its chats.
 */
export function LockedAgentCard({ agent, ownerName, onChanged }: {
    agent: { id: string; name: string; role: string | null; status: string; monthlyCostCents: number; access: string };
    ownerName: string | null;
    onChanged?: () => void;
}) {
    const t = useTranslations("access.locked");
    const owner = ownerName ?? t("itsOwner");
    return (
        <main className="emperor-panel space-y-4 rounded-2xl p-4 sm:p-5">
            <div className="flex items-start gap-3">
                <IconLock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 space-y-1">
                    <h2 className="text-lg font-semibold text-foreground">{agent.name}</h2>
                    <p className="text-sm text-muted-foreground">
                        {agent.access === "owner" ? t("onlyOwner", { owner }) : t("ownerAndPeople", { owner })}
                        {" "}{t("adminNote")}
                    </p>
                </div>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <div><dt className="text-xs text-muted-foreground">{t("owner")}</dt><dd className="text-foreground">{ownerName ?? t("noOwner")}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t("status")}</dt><dd className="capitalize text-foreground">{agent.status}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t("costThisMonth")}</dt><dd className="text-foreground">${(agent.monthlyCostCents / 100).toFixed(2)}</dd></div>
            </dl>
            <AgentAccessSettings agentId={agent.id} onChanged={onChanged} />
        </main>
    );
}
