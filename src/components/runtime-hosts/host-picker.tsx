"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { IconCircleCheck, IconLoader2, IconServer2 } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { DEFAULT_HOST_MODEL, isHostLlmProvider, type HostLlmProvider } from "@/lib/runtime-hosts/commands";
import { hireReasonCopy, type HireReadiness } from "@/lib/runtime-hosts/hire";
import { useCopy } from "@/lib/i18n/use-copy";
import { JobProgress } from "./job-progress";

/** A host as the hire dialog needs it (GET /api/runtime-hosts). */
export type HireHost = {
    id: string;
    name: string;
    status: string;
    arch: string | null;
    resources: { memAvailMiB: number | null; memTotalMiB: number | null };
    capabilities: { browser: boolean };
    agents: { id: string }[];
    hire: HireReadiness;
};

const PROVIDER_LABEL: Record<HostLlmProvider, string> = {
    openrouter: "OpenRouter",
    deepseek: "DeepSeek",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google Gemini",
    grok: "Grok (xAI)",
};

function mb(value: number | null): string {
    if (value == null) return "?";
    return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value} MB`;
}

/** Host statuses with a label under runtimeHosts.hostStatus (anything else shows as is). */
const HOST_STATUSES = new Set(["online", "offline", "revoked", "pending"]);

/** A host's status as a translated label. */
export function useHostStatusLabel() {
    const t = useTranslations("runtimeHosts.hostStatus");
    return (status: string) => HOST_STATUSES.has(status) ? t(status as "online") : status;
}

/** Why a host cannot take a new agent, in the viewer's language (lib/runtime-hosts/hire.ts reason, translated by code). */
export function useHireReasonLabel() {
    const render = useCopy();
    return (hire: Pick<HireReadiness, "code" | "reason" | "reasonValues">): string | null =>
        hire.reason ? render(hireReasonCopy(hire), hire.reason) : null;
}

/**
 * The company's connected hosts for the hire dialog. Owners and admins only:
 * anyone else (403) or a company without hosts gets an empty list and the
 * dialog keeps the manual path.
 */
export function useHireHosts(enabled: boolean): { hosts: HireHost[] | null; forbidden: boolean } {
    const [hosts, setHosts] = useState<HireHost[] | null>(null);
    const [forbidden, setForbidden] = useState(false);
    useEffect(() => {
        if (!enabled) return;
        let stopped = false;
        fetch("/api/runtime-hosts", { cache: "no-store" })
            .then(async (res) => {
                if (stopped) return;
                if (res.status === 403 || res.status === 401) {
                    setForbidden(true);
                    setHosts([]);
                    return;
                }
                const data = res.ok ? await res.json() as { hosts: HireHost[] } : { hosts: [] };
                if (!stopped) setHosts(data.hosts.filter((h) => h.status !== "revoked"));
            })
            .catch(() => { if (!stopped) setHosts([]); });
        return () => { stopped = true; };
    }, [enabled]);
    return { hosts, forbidden };
}

export type HostChoice = { hostId: string; llmProvider: HostLlmProvider; model: string };

/**
 * "Another machine": pick a connected host (or set the agent up by hand),
 * then its model provider (only the providers that host has a key for) and
 * model. A host that cannot take the agent is shown disabled with the reason.
 */
export function HostPicker({ hosts, forbidden, value, onChange }: {
    hosts: HireHost[] | null;
    forbidden: boolean;
    value: HostChoice | null;
    onChange: (choice: HostChoice | null) => void;
}) {
    const t = useTranslations("runtimeHosts.picker");
    const statusLabel = useHostStatusLabel();
    const hireReason = useHireReasonLabel();
    if (hosts === null) {
        return <div className="h-16 animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/50" aria-label={t("loading")} />;
    }
    if (hosts.length === 0) {
        return (
            <p className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-[11px] leading-relaxed text-zinc-400">
                {t("noHosts")}
                {!forbidden && (
                    <> {t.rich("connectHostHint", { link: (chunks) => <Link href="/settings?tab=runtime-hosts" className="text-cyan-400 underline underline-offset-2 hover:text-cyan-300">{chunks}</Link> })}</>
                )}
            </p>
        );
    }
    const selected = value ? hosts.find((h) => h.id === value.hostId) ?? null : null;
    const pick = (host: HireHost) => {
        const llmProvider = host.hire.providers[0];
        if (!host.hire.ok || !llmProvider) return;
        onChange({ hostId: host.id, llmProvider, model: DEFAULT_HOST_MODEL[llmProvider] });
    };
    return (
        <div className="space-y-2">
            <div role="radiogroup" aria-label={t("host")} className="grid gap-2">
                {hosts.map((host) => {
                    const active = value?.hostId === host.id;
                    const disabled = !host.hire.ok;
                    return (
                        <button key={host.id} type="button" role="radio" aria-checked={active} disabled={disabled} onClick={() => pick(host)}
                            title={disabled ? hireReason(host.hire) ?? undefined : undefined}
                            className={cn(
                                "flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                                disabled ? "cursor-not-allowed border-zinc-800/60 bg-zinc-900/30 text-zinc-500"
                                    : active ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100" : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:border-zinc-600",
                            )}>
                            <IconServer2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-x-2">
                                    <span className="font-medium">{host.name}</span>
                                    <span className={cn("text-[10px]", host.status === "online" ? "text-emerald-400" : "text-amber-400")}>{statusLabel(host.status)}</span>
                                </span>
                                <span className="block text-[10px] opacity-80">
                                    {t("hostSummary", { free: mb(host.resources.memAvailMiB), needs: mb(host.hire.needMiB), browser: host.capabilities.browser ? "yes" : "no", count: host.agents.length })}
                                    {host.hire.gateway === "shared" ? t("sharedGatewaySuffix") : ""}
                                </span>
                                {disabled && host.hire.reason && <span className="block text-[10px] text-amber-300/90">{hireReason(host.hire)}</span>}
                            </span>
                        </button>
                    );
                })}
                <button type="button" role="radio" aria-checked={value === null} onClick={() => onChange(null)}
                    className={cn("rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                        value === null ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100" : "border-zinc-800 bg-zinc-900/70 text-zinc-400 hover:border-zinc-600")}>
                    <span className="font-medium">{t("manual")}</span>
                    <span className="block text-[10px] opacity-80">{t("manualHint")}</span>
                </button>
            </div>
            {selected && value && (
                <div className="grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{t("modelProvider")}</span>
                        <select value={value.llmProvider} className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-200 outline-none focus:border-cyan-400"
                            onChange={(e) => {
                                const next = e.target.value;
                                if (isHostLlmProvider(next)) onChange({ ...value, llmProvider: next, model: DEFAULT_HOST_MODEL[next] });
                            }}>
                            {selected.hire.providers.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
                        </select>
                    </label>
                    <label className="space-y-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{t("model")}</span>
                        <input value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} placeholder={DEFAULT_HOST_MODEL[value.llmProvider]}
                            className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-100 outline-none focus:border-cyan-400" />
                    </label>
                    <p className="text-[10px] leading-relaxed text-zinc-400 sm:col-span-2">
                        {t("keyHint", { provider: PROVIDER_LABEL[value.llmProvider], host: selected.name })}
                        {selected.hire.gateway === "shared" && ` ${t("sharedGatewayHint")}`}
                    </p>
                </div>
            )}
        </div>
    );
}

/**
 * After a hire onto a host: the setup job's live progress, then the agent
 * coming online, with a link to chat with it.
 */
export function HireProgress({ jobId, agentId, agentName, hostName }: { jobId: string; agentId: string; agentName: string; hostName: string }) {
    const t = useTranslations("runtimeHosts.hire");
    const [jobDone, setJobDone] = useState<"ok" | "failed" | null>(null);
    const [online, setOnline] = useState(false);
    useEffect(() => {
        if (jobDone !== "ok" || online) return;
        let stopped = false;
        const tick = async () => {
            try {
                const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, { cache: "no-store" });
                const data = res.ok ? await res.json() as { agent?: { status?: string } } : null;
                if (!stopped && data?.agent?.status && data.agent.status !== "offline") setOnline(true);
            } catch {
                // keep polling
            }
            if (!stopped) timer = setTimeout(() => void tick(), 2000);
        };
        let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => void tick(), 500);
        return () => { stopped = true; if (timer) clearTimeout(timer); };
    }, [jobDone, online, agentId]);

    return (
        <div className="min-w-0 space-y-3 py-2">
            <p className="text-sm text-zinc-300">{t("settingUp", { agent: agentName, host: hostName })}</p>
            <JobProgress jobId={jobId} onDone={(job) => setJobDone(job.status === "succeeded" ? "ok" : "failed")} />
            {jobDone === "ok" && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
                    {online ? <IconCircleCheck className="h-4 w-4" aria-hidden="true" /> : <IconLoader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                    <span>{online ? t("online", { agent: agentName }) : t("waitingHeartbeat", { agent: agentName })}</span>
                    <Link href={`/messages?agent=${encodeURIComponent(agentId)}`} className="ml-auto text-cyan-300 underline underline-offset-2 hover:text-cyan-200">{t("chatWith", { agent: agentName })}</Link>
                </div>
            )}
            {jobDone === "failed" && (
                <p className="text-xs text-rose-200">
                    {t.rich("failed", { agent: agentName, link: (chunks) => <Link href={`/agents?agent=${encodeURIComponent(agentId)}`} className="underline underline-offset-2">{chunks}</Link> })}
                </p>
            )}
        </div>
    );
}
