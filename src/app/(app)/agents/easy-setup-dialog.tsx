"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createClientRequestId } from "@/lib/client-request-id";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { EVERYONE_ACCESS, WhoCanUseField, hireAccessBody, useAccessPeople, type AgentAccessValue } from "@/components/access/agent-access-control";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { HermesImageProgress } from "@/components/hermes-image-progress";
import { RoleTemplatePicker } from "./role-template-picker";
import { SetupOutputLog, type SetupOutputEntry } from "@/components/setup-output-log";
import { getAgentTemplate } from "@/lib/agent-templates";
import { TEAM_TEMPLATES, DEFAULT_AGENT_NAMES, type TeamTemplateId } from "@/lib/onboarding-shared";
import { cn } from "@/lib/utils";
import { CUSTOM_LLM_PROVIDER, normalizeLlmBaseUrl } from "@/lib/llm-endpoint";
import { useHireHosts, type HostChoice } from "@/components/runtime-hosts/host-picker";
import { JobProgress } from "@/components/runtime-hosts/job-progress";
import { DEFAULT_HOST_MODEL, isHostLlmProvider, isValidHostModel } from "@/lib/runtime-hosts/commands";

// Matches MAX_EASY_SETUP_AGENTS in src/app/api/agents/easy-setup/route.ts — kept
// as a local constant (not imported) so this client component doesn't pull in
// server-only route dependencies.
const MAX_EASY_SETUP_AGENTS = 10;

// Easy Setup offers the providers we support for one-click local hiring:
// OpenRouter (free default model, no billing surprise), DeepSeek, and any
// OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, LiteLLM). Every other
// provider stays reachable through the Advanced create-agent flow.
/** Product names; the custom endpoint is labelled by agents.easySetup.customEndpoint. */
const LLM_PROVIDER_OPTIONS: { id: string; label: string | null }[] = [
    { id: "openrouter", label: "OpenRouter" },
    { id: "deepseek", label: "DeepSeek" },
    { id: CUSTOM_LLM_PROVIDER, label: null },
];
const BASE_URL_EXAMPLE = "http://host.docker.internal:11434/v1";

// Default model per provider, so a hired worker can reply without the operator
// knowing a model name. OpenRouter's Nemotron 3 Ultra is free.
const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
    openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free",
    deepseek: "",
    [CUSTOM_LLM_PROVIDER]: "",
};

const DEFAULT_LLM_PROVIDER = LLM_PROVIDER_OPTIONS[0].id;

type EasyStep = "count-and-roles" | "provider-key" | "provisioning" | "done";

type AgentSpecState = {
    id: string;
    templateId: string | null;
    role: string;
    name: string;
};

type AgentBatchResult = {
    name: string;
    agentId: string | null;
    success: boolean;
    message: string;
    outputs: SetupOutputEntry[];
    reused?: boolean;
    /** Set up on a runtime host (0.22): its setup job, followed live. */
    jobId?: string;
};

function makeSpec(index: number): AgentSpecState {
    const id = createClientRequestId();
    return { id, templateId: null, role: "Custom", name: `Agent ${index + 1}` };
}

// Grows/shrinks the spec list to `count` entries without disturbing the rows
// that still exist — only appends new rows or truncates trailing ones.
function resizeSpecs(specs: AgentSpecState[], count: number): AgentSpecState[] {
    if (count <= specs.length) return specs.slice(0, count);
    const next = [...specs];
    for (let i = specs.length; i < count; i++) next.push(makeSpec(i));
    return next;
}

export function EasySetupDialog({
    onAgentCreated,
    onSwitchToAdvanced,
    localOnly = false,
    defaultOpen = false,
}: {
    onAgentCreated?: (agentId: string) => void;
    onSwitchToAdvanced: () => void;
    localOnly?: boolean;
    /** Open on mount (the command palette's Hire agent: /agents?hire=1). */
    defaultOpen?: boolean;
}) {
    const t = useTranslations("agents.easySetup");
    const tc = useTranslations("common");
    const router = useRouter();
    const [open, setOpen] = useState(defaultOpen);
    const [step, setStep] = useState<EasyStep>("count-and-roles");
    const [count, setCount] = useState(1);
    const [specs, setSpecs] = useState<AgentSpecState[]>([makeSpec(0)]);
    const [teamTemplateId, setTeamTemplateId] = useState<TeamTemplateId | null>(null);
    const [teamName, setTeamName] = useState("");
    const [teamLeadSpecId, setTeamLeadSpecId] = useState("");
    const [teamRequestId, setTeamRequestId] = useState<string | null>(null);
    const [teamGroupId, setTeamGroupId] = useState<string | null>(null);
    const [teamError, setTeamError] = useState<string | null>(null);
    const [teamBusy, setTeamBusy] = useState(false);
    const [retryingRuntime, setRetryingRuntime] = useState<string | null>(null);
    const [llmProvider, setLlmProvider] = useState(DEFAULT_LLM_PROVIDER);
    const [llmApiKey, setLlmApiKey] = useState("");
    const [llmModel, setLlmModel] = useState(DEFAULT_MODEL_BY_PROVIDER[DEFAULT_LLM_PROVIDER]);
    const [llmBaseUrl, setLlmBaseUrl] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<AgentBatchResult[] | null>(null);
    const [expanded, setExpanded] = useState<Record<number, boolean>>({});

    const [available, setAvailable] = useState<boolean | null>(null);
    const [availabilityReason, setAvailabilityReason] = useState("");
    const [configurations, setConfigurations] = useState<{ id: string; name: string; llmProvider: string }[]>([]);
    const [sourceAgentId, setSourceAgentId] = useState("");
    const [whoCanUse, setWhoCanUse] = useState<AgentAccessValue>(EVERYONE_ACCESS);
    const accessPeople = useAccessPeople(open && step === "provider-key");
    // Runtime hosts (0.22): a connected machine can take the agents instead of this server's Docker.
    const { hosts } = useHireHosts(open && !localOnly);
    const [hostTarget, setHostTarget] = useState<HostChoice | null>(null);
    const [targetTouched, setTargetTouched] = useState(false);
    const chosenHost = hostTarget ? hosts?.find((h) => h.id === hostTarget.hostId) ?? null : null;
    const onHost = Boolean(hostTarget && chosenHost);
    const checkAvailability = useCallback(async () => {
        setAvailable(null);
        try {
            const response = await fetch("/api/agents/easy-setup", { cache: "no-store" });
            if (!response.ok) throw new Error(t("checkFailedRetry"));
            const data = await response.json().catch(() => null);
            if (!data) throw new Error(t("checkFailedSignIn"));
            setConfigurations(data.configurations || []);
            // Hiring next to an agent that already works: reuse its connection by default.
            setSourceAgentId((current) => current || data.configurations?.[0]?.id || "");
            setAvailable(Boolean(data.available));
            setAvailabilityReason(data.reason || t("unavailable"));
        } catch (e) {
            setAvailable(false);
            setAvailabilityReason(e instanceof Error ? e.message : t("checkFailed"));
        }
    }, [t]);
    useEffect(() => { if (open) void checkAvailability(); }, [open, checkAvailability]);
    // Without Docker here, a connected host that can take agents is chosen for you (once).
    useEffect(() => {
        if (!hosts || targetTouched || hostTarget || available !== false) return;
        const ready = hosts.find((h) => h.hire.ok && h.hire.providers.length > 0);
        if (ready) setHostTarget({ hostId: ready.id, llmProvider: ready.hire.providers[0], model: DEFAULT_HOST_MODEL[ready.hire.providers[0]] });
    }, [hosts, targetTouched, hostTarget, available]);
    const pickTarget = (choice: HostChoice | null) => { setTargetTouched(true); setHostTarget(choice); };

    const resetForm = () => {
        setStep("count-and-roles");
        setCount(1);
        setSpecs([makeSpec(0)]);
        setTeamTemplateId(null);
        setTeamName("");
        setTeamLeadSpecId("");
        setTeamRequestId(null);
        setTeamGroupId(null);
        setTeamError(null);
        setLlmProvider(DEFAULT_LLM_PROVIDER);
        setLlmApiKey("");
        setLlmModel(DEFAULT_MODEL_BY_PROVIDER[DEFAULT_LLM_PROVIDER]);
        setLlmBaseUrl("");
        setSourceAgentId("");
        setSubmitting(false);
        setError(null);
        setResults(null);
        setExpanded({});
        setHostTarget(null);
        setTargetTouched(false);
    };

    const handleCountChange = (nextCount: number) => {
        const clamped = Math.max(1, Math.min(MAX_EASY_SETUP_AGENTS, Number.isFinite(nextCount) ? nextCount : 1));
        setCount(clamped);
        setSpecs((prev) => resizeSpecs(prev, clamped));
    };

    const updateSpec = (id: string, fields: Partial<AgentSpecState>) => {
        setSpecs((prev) => prev.map((s) => (s.id === id ? { ...s, ...fields } : s)));
    };

    const chooseTeam = (id: TeamTemplateId) => {
        if (teamTemplateId === id) return;
        const template = TEAM_TEMPLATES.find(team => team.id === id)!;
        const members = template.roles.map((role, index) => ({ ...makeSpec(index), templateId: role,
            role: getAgentTemplate(role)!.title, name: DEFAULT_AGENT_NAMES[role] || role }));
        setTeamTemplateId(id);
        setTeamName(template.group.title);
        setSpecs(members);
        setCount(members.length);
        setTeamLeadSpecId(members[0].id);
        setTeamRequestId(createClientRequestId());
        setTeamGroupId(null);
        setTeamError(null);
    };
    const createTeamChat = async (batch: AgentBatchResult[]) => {
        if (!teamTemplateId || teamGroupId || teamBusy) return;
        if (batch.length !== specs.length || batch.some(result => !result.agentId)) {
            setTeamError(t("team.remainingFirst"));
            return;
        }
        setTeamBusy(true);
        setTeamError(null);
        try {
            const template = TEAM_TEMPLATES.find(team => team.id === teamTemplateId)!;
            const leaderIndex = specs.findIndex(spec => spec.id === teamLeadSpecId);
            if (leaderIndex < 0) throw new Error(t("team.chooseLeader"));
            const response = await fetch("/api/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
                requestId: teamRequestId, title: teamName.trim(), description: template.group.description,
                icon: template.icon, agentIds: batch.map(result => result.agentId),
                coordinator: { kind: "agent", id: batch[leaderIndex].agentId },
            }) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.group?.id) throw new Error(data.error || t("team.chatFailed"));
            setTeamGroupId(data.group.id);
        } catch (error) {
            setTeamError(error instanceof Error ? error.message : t("team.chatFailed"));
        } finally {
            setTeamBusy(false);
        }
    };
    const retryRuntime = async (agentId: string) => {
        setRetryingRuntime(agentId);
        try {
            const response = await fetch(`/api/agents/${agentId}/recreate-runtime`, { method: "POST" });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.success) throw new Error(data.error || data.message || t("restartFailed"));
            setResults(previous => previous?.map(result => result.agentId === agentId ? { ...result, message: t("restartRequested") } : result) ?? null);
        } catch (error) {
            setError(error instanceof Error ? error.message : t("restartFailed"));
        } finally {
            setRetryingRuntime(null);
        }
    };

    /** On a runtime host: one hire per agent (POST /api/agents with the host); each setup runs there in turn. */
    const handleCreateOnHost = async (requested: { spec: AgentSpecState; index: number }[]) => {
        if (!hostTarget || !chosenHost) return;
        setStep("provisioning");
        setSubmitting(true);
        setError(null);
        try {
            const returned: AgentBatchResult[] = [];
            for (const { spec: s } of requested) {
                const template = s.templateId ? getAgentTemplate(s.templateId) : null;
                const name = s.name.trim() || s.role;
                const res = await fetch("/api/agents", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name, role: s.role, provider: "hermes", runtimeHostId: hostTarget.hostId, llmProvider: hostTarget.llmProvider,
                        model: hostTarget.model.trim() || undefined, ...hireAccessBody(whoCanUse),
                        doctrineJson: template ? { "SOUL.md": template.soul, "AGENTS.md": template.agents, "BOOTSTRAP.md": template.bootstrap, "IDENTITY.md": template.identity } : {},
                    }),
                });
                const data = await res.json().catch(() => ({}));
                returned.push(res.ok
                    ? { name, agentId: data.agent?.id ?? null, success: true, message: t("settingUpOn", { host: chosenHost.name }), outputs: [], jobId: data.jobId }
                    : { name, agentId: null, success: false, message: data.error || t("hireFailed"), outputs: [] });
            }
            const batch = specs.map((spec, index) => {
                const requestedIndex = requested.findIndex(item => item.index === index);
                return requestedIndex < 0 ? results![index] : returned[requestedIndex];
            });
            setResults(batch);
            setExpanded(Object.fromEntries(batch.map((r, i) => [i, true])));
            setStep("done");
            const created = batch.find((r) => r.agentId);
            if (created?.agentId && !teamTemplateId) onAgentCreated?.(created.agentId);
            await createTeamChat(batch);
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : t("hiringFailed"));
            setStep(results?.some(result => result.agentId) ? "done" : "provider-key");
        } finally {
            setSubmitting(false);
        }
    };

    const handleCreate = async () => {
        if (onHost) {
            if (submitting) return;
            const requested = specs.map((spec, index) => ({ spec, index })).filter(({ index }) => !results?.[index]?.agentId);
            if (requested.length) await handleCreateOnHost(requested);
            return;
        }
        if (submitting || available !== true) return;
        // Existing profiles are never recreated when a batch is retried.
        const requested = specs.map((spec, index) => ({ spec, index })).filter(({ index }) => !results?.[index]?.agentId);
        if (!requested.length) return;
        setStep("provisioning");
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch("/api/agents/easy-setup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sourceAgentId: sourceAgentId || undefined,
                    llmProvider,
                    llmApiKey,
                    llmModel: llmModel.trim() || undefined,
                    llmBaseUrl: llmProvider === CUSTOM_LLM_PROVIDER ? llmBaseUrl.trim() : undefined,
                    ...hireAccessBody(whoCanUse),
                    agents: requested.map(({ spec: s }) => {
                        const template = s.templateId ? getAgentTemplate(s.templateId) : null;
                        return { requestId: s.id, role: s.role, name: s.name.trim() || s.role, doctrineJson: template ? {
                            "SOUL.md": template.soul, "AGENTS.md": template.agents, "BOOTSTRAP.md": template.bootstrap, "IDENTITY.md": template.identity,
                        } : {} };
                    }),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || t("failed"));
            const returned: AgentBatchResult[] = data.results || [];
            const batch = specs.map((spec, index) => {
                const requestedIndex = requested.findIndex(item => item.index === index);
                return requestedIndex < 0 ? results![index] : returned[requestedIndex] ?? {
                    name: spec.name, agentId: null, success: false, message: t("noResult"), outputs: [],
                };
            });
            setResults(batch);
            setExpanded(Object.fromEntries(batch.map((r: AgentBatchResult, i: number) => [i, !r.success])));
            setStep("done");
            const created = batch.find((r: AgentBatchResult) => r.success && r.agentId);
            if (created?.agentId) {
                // Only clear the key and advance once a worker actually came up.
                // A failed runtime download used to still advance, stranding the
                // operator on an agent stuck at "disconnected" with no retry.
                setLlmApiKey("");
                setSourceAgentId(created.agentId);
                if (!teamTemplateId) onAgentCreated?.(created.agentId);
            }
            await createTeamChat(batch);
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : t("failed"));
            setStep(results?.some(result => result.agentId) ? "done" : "provider-key");
        } finally {
            setSubmitting(false);
        }
    };

    const handleViewAgents = () => {
        const firstSuccess = results?.find((r) => r.success && r.agentId) || results?.find((r) => r.agentId);
        setOpen(false);
        resetForm();
        router.refresh();
        if (!teamTemplateId && firstSuccess?.agentId) onAgentCreated?.(firstSuccess.agentId);
    };

    const handleAdvanced = () => {
        setOpen(false);
        resetForm();
        onSwitchToAdvanced();
    };

    const successCount = results?.filter((r) => r.success).length ?? 0;
    const customEndpoint = llmProvider === CUSTOM_LLM_PROVIDER;
    const baseUrlCheck = customEndpoint && llmBaseUrl.trim() ? normalizeLlmBaseUrl(llmBaseUrl) : null;
    // A custom endpoint needs a URL and a model; its key is optional (local servers have none).
    const connectionReady = Boolean(sourceAgentId) || (customEndpoint
        ? Boolean(baseUrlCheck?.ok) && Boolean(llmModel.trim())
        : Boolean(llmApiKey.trim()));
    const canContinueRoles = specs.every((s) => s.name.trim().length > 0) && (!teamTemplateId || (Boolean(teamName.trim()) && specs.some(spec => spec.id === teamLeadSpecId)));
    // Where it runs decides what "ready" means: a host needs a provider it has a key for; this server needs Docker and a key.
    const canRun = onHost ? Boolean(chosenHost?.hire.ok) : available === true;
    const readyToCreate = onHost ? Boolean(hostTarget?.llmProvider) && (!hostTarget?.model.trim() || isValidHostModel(hostTarget.model.trim())) : connectionReady;
    const hostOptions = (hosts ?? []).filter((h) => h.status !== "revoked");

    return (
        <Dialog open={open} onOpenChange={(o) => { if (submitting || teamBusy) return; setOpen(o); if (!o) resetForm(); }}>
            <DialogTrigger asChild>
                <Button variant="default" className="shadow-sm">{t("trigger")}</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[640px] max-h-[90dvh] flex flex-col overflow-hidden bg-background border-border text-foreground">
                <DialogHeader className="shrink-0">
                    <DialogTitle className="text-foreground">
                        {step === "count-and-roles" && t("titles.roles")}
                        {step === "provider-key" && (onHost ? t("titles.model") : t("titles.provider"))}
                        {step === "provisioning" && t("titles.provisioning")}
                        {step === "done" && t("titles.done")}
                    </DialogTitle>
                    <DialogDescription className="text-muted-foreground">
                        {step === "count-and-roles" && (onHost
                            ? t("hints.rolesHost", { host: chosenHost?.name ?? "" })
                            : t("hints.roles"))}
                        {step === "provider-key" && (onHost
                            ? t("hints.modelHost", { host: chosenHost?.name ?? "" })
                            : t("hints.provider"))}
                        {step === "provisioning" && t("hints.provisioning")}
                        {step === "done" && t("hints.done")}
                    </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto px-1">
                {step !== "provisioning" && step !== "done" && !onHost && available !== true && (
                    <div className="rounded-lg border border-amber-500/20 px-3 py-2 text-sm text-amber-800 dark:text-amber-200" role="status">
                        {available === null ? t("checking") : <>
                            <p>{availabilityReason}</p>
                            <div className="mt-2 flex gap-3">
                                <button type="button" onClick={() => void checkAvailability()} className="min-h-11 underline">{tc("retry")}</button>
                                <a href="/docs/v1.1/installation" target="_blank" rel="noreferrer" className="underline">{t("dockerGuide")}</a>
                            </div>
                        </>}
                    </div>
                )}

                {/* Step: count-and-roles */}
                {step === "count-and-roles" && (
                    <div className="space-y-4 py-2">
                        {hostOptions.length > 0 && (
                            <div className="space-y-2">
                                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{t("whereRun")}</p>
                                <div role="radiogroup" aria-label={t("whereRun")} className="grid gap-2 sm:grid-cols-2">
                                    {hostOptions.map((h) => {
                                        const active = hostTarget?.hostId === h.id;
                                        return (
                                            <button key={h.id} type="button" role="radio" aria-checked={active} disabled={!h.hire.ok}
                                                onClick={() => h.hire.ok && pickTarget({ hostId: h.id, llmProvider: h.hire.providers[0], model: DEFAULT_HOST_MODEL[h.hire.providers[0]] })}
                                                className={cn("min-h-14 rounded-lg border p-3 text-left text-sm", !h.hire.ok ? "cursor-not-allowed border-border opacity-60"
                                                    : active ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}>
                                                <span className="block font-medium">{h.name}</span>
                                                <span className="block text-xs text-muted-foreground">{h.hire.ok ? t("hostSummary", { count: h.agents.length, providers: h.hire.providers.join(", ") }) : h.hire.reason}</span>
                                            </button>
                                        );
                                    })}
                                    <button type="button" role="radio" aria-checked={!hostTarget} disabled={available !== true} onClick={() => pickTarget(null)}
                                        className={cn("min-h-14 rounded-lg border p-3 text-left text-sm", available !== true ? "cursor-not-allowed border-border opacity-60"
                                            : !hostTarget ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}>
                                        <span className="block font-medium">{t("thisServer")}</span>
                                        <span className="block text-xs text-muted-foreground">{available === true ? t("dockerReady") : available === null ? t("checkingDocker") : t("noDocker")}</span>
                                    </button>
                                </div>
                            </div>
                        )}
                        <div className="flex gap-2" aria-label={t("hiringSetup")}>
                            <Button type="button" variant={!teamTemplateId ? "default" : "outline"} aria-pressed={!teamTemplateId} onClick={() => { if (!teamTemplateId) return; setTeamTemplateId(null); setTeamName(""); setSpecs([makeSpec(0)]); setCount(1); }}>{t("oneAgent")}</Button>
                            <Button type="button" variant={teamTemplateId ? "default" : "outline"} aria-pressed={Boolean(teamTemplateId)} onClick={() => { if (!teamTemplateId) chooseTeam("development"); }}>{t("aTeam")}</Button>
                        </div>
                        {teamTemplateId && <div className="space-y-3 rounded-xl border border-border p-4">
                            <p className="text-sm text-muted-foreground">{t("team.includes", { count: specs.length })}</p>
                            <div className="grid grid-cols-2 gap-2">{TEAM_TEMPLATES.map(team => <button type="button" key={team.id} aria-pressed={team.id === teamTemplateId} onClick={() => chooseTeam(team.id)} className={cn("min-h-14 rounded-lg border p-3 text-left", team.id === teamTemplateId ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}><span className="block text-sm font-medium">{team.icon} {t(`teams.${team.id}.label`)}</span><span className="text-xs text-muted-foreground">{t(`teams.${team.id}.hint`)}</span></button>)}</div>
                            <label className="block text-sm">{t("team.name")}<input value={teamName} maxLength={80} onChange={event => setTeamName(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-border bg-background px-3" /></label>
                            <label className="block text-sm">{t("team.leader")}<select aria-label={t("team.leader")} value={teamLeadSpecId} onChange={event => setTeamLeadSpecId(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-border bg-background px-3">{specs.map(spec => <option key={spec.id} value={spec.id}>{spec.name || spec.role}</option>)}</select></label>
                            <p className="text-xs text-muted-foreground">{t("team.reportingHint")}</p>
                        </div>}
                        {!teamTemplateId && <details className="text-sm text-muted-foreground">
                            <summary className="cursor-pointer">{t("moreThanOne")}</summary>
                        <div className="space-y-1.5">
                            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("howMany")}</label>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => handleCountChange(count - 1)}
                                    disabled={count <= 1}
                                    aria-label={t("fewer")}
                                    className="h-8 w-8 rounded-lg border border-border bg-muted text-foreground hover:border-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    {"−"}
                                </button>
                                <input
                                    type="number"
                                    min={1}
                                    max={MAX_EASY_SETUP_AGENTS}
                                    value={count}
                                    onChange={(e) => handleCountChange(parseInt(e.target.value, 10))}
                                    className="w-16 bg-muted border border-border focus:ring-1 focus:ring-cyan-500 rounded-lg px-3 py-1.5 text-sm text-foreground outline-none text-center"
                                />
                                <button
                                    type="button"
                                    onClick={() => handleCountChange(count + 1)}
                                    disabled={count >= MAX_EASY_SETUP_AGENTS}
                                    aria-label={t("more")}
                                    className="h-8 w-8 rounded-lg border border-border bg-muted text-foreground hover:border-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    +
                                </button>
                                {count >= MAX_EASY_SETUP_AGENTS && (
                                    <span className="text-xs text-amber-300">{t("maxPerBatch", { max: MAX_EASY_SETUP_AGENTS })}</span>
                                )}
                            </div>
                        </div>

                        </details>}

                        <div className="space-y-3">
                            {specs.map((spec, i) => (
                                <div key={spec.id} className="rounded-xl border border-border bg-muted/50 p-3 space-y-2">
                                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentN", { n: i + 1 })}</span>
                                    <details open={!teamTemplateId}><summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">{getAgentTemplate(spec.templateId || "")?.emoji} {spec.role} · {t("changeRole")}</summary>
                                    <RoleTemplatePicker
                                        selectedId={spec.templateId}
                                        allowCustom
                                        onSelect={(roleId) => {
                                            const template = roleId ? getAgentTemplate(roleId) : null;
                                            updateSpec(spec.id, {
                                                templateId: roleId,
                                                role: template?.title || "Custom",
                                                name: template?.title || spec.name,
                                            });
                                        }}
                                    /></details>
                                    <input
                                        className="w-full bg-muted border-border focus:ring-1 focus:ring-cyan-500 rounded-lg px-3 py-2 text-sm text-foreground outline-none"
                                        aria-label={t("agentNName", { n: i + 1 })}
                                        maxLength={200}
                                        placeholder={t("agentName")}
                                        value={spec.name}
                                        onChange={(e) => updateSpec(spec.id, { name: e.target.value })}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Step: provider-key */}
                {step === "provider-key" && onHost && hostTarget && chosenHost && (
                    <div className="space-y-4 py-2">
                        <label className="block space-y-1.5 text-sm text-foreground">
                            {t("modelProvider")}
                            <select value={hostTarget.llmProvider} className="block w-full rounded-lg border border-border bg-muted p-2"
                                onChange={(e) => { const next = e.target.value; if (isHostLlmProvider(next)) setHostTarget({ ...hostTarget, llmProvider: next, model: DEFAULT_HOST_MODEL[next] }); }}>
                                {chosenHost.hire.providers.map((p) => <option key={p} value={p}>{p}</option>)}
                            </select>
                            <span className="block text-xs text-muted-foreground">{t("onlyProviders", { host: chosenHost.name })}</span>
                        </label>
                        <label className="block space-y-1.5 text-sm text-foreground">
                            {t("model")}
                            <input value={hostTarget.model} onChange={(e) => setHostTarget({ ...hostTarget, model: e.target.value })} maxLength={128}
                                placeholder={DEFAULT_HOST_MODEL[hostTarget.llmProvider]} className="block w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground" />
                        </label>
                        {specs.length > 1 && <p className="text-xs text-muted-foreground">{t("oneAfterOther", { host: chosenHost.name })}</p>}
                        <WhoCanUseField value={whoCanUse} onChange={setWhoCanUse} people={accessPeople.people} me={accessPeople.me} />
                        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                    </div>
                )}

                {step === "provider-key" && !onHost && (
                    <div className="space-y-4 py-2">
                        {configurations.length > 0 && (
                            <label className="block space-y-2 text-sm text-foreground">
                                {t("llmConnection")}
                                <select value={sourceAgentId} onChange={e => setSourceAgentId(e.target.value)} className="block w-full rounded-lg border border-border bg-muted p-2">
                                    <option value="">{t("enterKey")}</option>
                                    {configurations.map(c => <option key={c.id} value={c.id}>{t("reuse", { name: c.name, provider: c.llmProvider })}</option>)}
                                </select>
                                <span className="block text-xs text-muted-foreground">{sourceAgentId ? t("reuseHint") : t("newKeyHint")}</span>
                            </label>
                        )}
                        {!sourceAgentId && <>
                        <div className="space-y-1.5">
                            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("llmProvider")}</label>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                {LLM_PROVIDER_OPTIONS.map((p) => (
                                    <button
                                        key={p.id}
                                        type="button"
                                        onClick={() => { setLlmProvider(p.id); setLlmModel(DEFAULT_MODEL_BY_PROVIDER[p.id] ?? ""); }}
                                        className={cn(
                                            "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                                            llmProvider === p.id
                                                ? "border-cyan-400/40 bg-cyan-400/10 text-primary"
                                                : "border-border bg-muted text-foreground hover:border-zinc-600"
                                        )}
                                    >
                                        {p.label ?? t("customEndpoint")}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {customEndpoint && (
                            <div className="space-y-1.5">
                                <label htmlFor="easy-setup-base-url" className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("baseUrl")}</label>
                                <input
                                    id="easy-setup-base-url"
                                    type="url"
                                    value={llmBaseUrl}
                                    onChange={(e) => setLlmBaseUrl(e.target.value)}
                                    placeholder={BASE_URL_EXAMPLE}
                                    autoComplete="off"
                                    aria-invalid={baseUrlCheck?.ok === false}
                                    className="w-full bg-muted border-border focus:ring-1 focus:ring-cyan-500 rounded-lg px-3 py-2 text-sm text-foreground outline-none"
                                />
                                {baseUrlCheck?.ok === false
                                    ? <p role="alert" className="text-xs text-destructive">{baseUrlCheck.error}</p>
                                    : <p className="text-xs text-muted-foreground">{baseUrlCheck?.ok && baseUrlCheck.hint ? baseUrlCheck.hint : t("baseUrlHint")}</p>}
                            </div>
                        )}
                        <div className="space-y-1.5">
                            <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("apiKey")}{customEndpoint && <span className="ml-1 normal-case font-normal tracking-normal">{t("optional")}</span>}</label>
                            <input
                                type="password"
                                value={llmApiKey}
                                onChange={(e) => setLlmApiKey(e.target.value)}
                                placeholder={customEndpoint ? t("keyOptionalPlaceholder") : t("keyPlaceholder")}
                                aria-label={t("keyLabel")}
                                autoComplete="off"
                                className="w-full bg-muted border-border focus:ring-1 focus:ring-cyan-500 rounded-lg px-3 py-2 text-sm text-foreground outline-none"
                            />
                        </div>
                        <label className="block space-y-1.5 text-sm text-foreground">
                            {t("model")} {!customEndpoint && <span className="text-muted-foreground">{t("optional")}</span>}
                            <input value={llmModel} onChange={e => setLlmModel(e.target.value)} maxLength={200}
                                placeholder={customEndpoint ? t("customModelPlaceholder") : DEFAULT_MODEL_BY_PROVIDER[llmProvider] || t("providerDefault")} className="block w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground" />
                        </label>
                        <p className="text-xs text-muted-foreground">
                            {t("encryptsKey")}
                            {specs.length > 1 && ` ${t("batchUsesConnection")}`}
                        </p>
                        </>}
                        <WhoCanUseField value={whoCanUse} onChange={setWhoCanUse} people={accessPeople.people} me={accessPeople.me} />
                        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                    </div>
                )}

                {/* Step: provisioning */}
                {step === "provisioning" && (
                    <div className="flex flex-col items-center justify-center gap-3 py-10 text-muted-foreground">
                        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-cyan-400" />
                        <span className="text-sm">{onHost ? t("hiringOn", { count: specs.length, host: chosenHost?.name ?? "" }) : t("provisioningCount", { count: specs.length })}</span>
                        {!onHost && <HermesImageProgress active className="w-full max-w-sm" />}
                    </div>
                )}

                {/* Step: done */}
                {step === "done" && results && (
                    <div className="space-y-3 py-2">
                        <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
                            {t("resultsSummary", { created: results.filter(result => result.agentId).length, total: specs.length, started: successCount })}
                        </div>
                        {successCount === 0 && (
                            <p className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                                {t("noneStarted")}
                            </p>
                        )}
                        {teamTemplateId && <div className="rounded-xl border border-border p-4">
                            {teamGroupId ? <><p className="text-sm font-medium">{t("team.chatReady", { name: teamName })}</p><div className="mt-3 flex flex-wrap gap-2"><Button asChild variant="outline"><Link href={`/messages?group=${teamGroupId}`}>{t("team.openChat")}</Link></Button><Button asChild variant="outline"><Link href="/agents/organization">{t("team.reviewReporting")}</Link></Button></div><p className="mt-2 text-xs text-muted-foreground">{t("team.orgChartHint")}</p></> : <><p role="status" className="text-sm">{teamBusy ? t("team.creatingChat") : teamError || t("team.waitingProfiles")}</p>{teamError && results.every(result => result.agentId) && <Button type="button" variant="outline" disabled={teamBusy} className="mt-3" onClick={() => void createTeamChat(results)}>{t("team.retryChat")}</Button>}</>}
                        </div>}
                        <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                            {results.map((r, i) => (
                                <div key={i} className="rounded-xl border border-border bg-muted/50 overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setExpanded((prev) => ({ ...prev, [i]: !prev[i] }))}
                                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
                                    >
                                        <span className="text-sm text-foreground">{r.name}</span>
                                        <span className={cn(
                                            "rounded-full px-2 py-0.5 text-xs font-medium",
                                            r.reused && !r.success ? "bg-muted text-muted-foreground" : r.success ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/15 text-destructive"
                                        )}>
                                            {r.reused && !r.success ? t("result.retained") : r.jobId ? t("result.settingUp") : r.success ? t("result.started") : t("result.failed")}
                                        </span>
                                    </button>
                                    {expanded[i] && (
                                        <div className="min-w-0 px-3 pb-3 space-y-2">
                                            <p className="text-xs text-muted-foreground">{r.message}</p>
                                            {r.jobId && <JobProgress jobId={r.jobId} />}
                                            {r.agentId && !r.success && !r.jobId && <Button type="button" variant="outline" disabled={retryingRuntime !== null} onClick={() => void retryRuntime(r.agentId!)}>{retryingRuntime === r.agentId ? t("restarting") : t("retryRuntime")}</Button>}
                                            {r.agentId && <Button asChild variant="outline"><Link href={`/agents?agent=${r.agentId}`}>{t("openAgent")}</Link></Button>}
                                            <SetupOutputLog outputs={r.outputs} />
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                </div>
                <DialogFooter className="shrink-0 border-t border-border pt-3 flex items-center gap-2">
                    {step === "provider-key" && (
                        <Button type="button" variant="outline" onClick={() => setStep("count-and-roles")} className="border-border text-foreground hover:bg-muted">{tc("back")}</Button>
                    )}
                    {step === "count-and-roles" && !localOnly && (
                        <button type="button" onClick={handleAdvanced} className="text-xs text-muted-foreground underline hover:text-foreground">{t("connectRemote")}</button>
                    )}
                    <div className="flex-1" />
                    {step !== "provisioning" && step !== "done" && (
                        <Button type="button" variant="outline" onClick={() => { setOpen(false); resetForm(); }} className="border-border text-foreground hover:bg-muted">{tc("cancel")}</Button>
                    )}
                    {step === "count-and-roles" && (
                        <DisabledReason reason={canContinueRoles ? null : !specs.every((s) => s.name.trim().length > 0) ? t("nameEveryAgent") : !teamName.trim() ? t("nameTheTeam") : t("chooseLead")}>
                            <Button type="button" onClick={() => setStep("provider-key")} disabled={!canContinueRoles} className="min-h-11">{t("continue")}</Button>
                        </DisabledReason>
                    )}
                    {step === "provider-key" && (
                        <Button type="button" onClick={handleCreate} disabled={submitting || !canRun || !readyToCreate} className="min-h-11">
                            {onHost ? t("hireOnHost", { host: chosenHost?.name ?? "" }) : t("createAndStart", { count: specs.length })}
                        </Button>
                    )}
                    {step === "done" && results?.some(result => !result.agentId) && (
                        <Button
                            type="button"
                            onClick={handleCreate}
                            disabled={submitting || !canRun || !readyToCreate}
                            className="min-h-11"
                        >
                            {t("retryProvisioning")}
                        </Button>
                    )}
                    {step === "done" && results?.some(result => result.agentId) && (
                        <Button type="button" onClick={handleViewAgents} className="min-h-11">
                            {results?.length === 1 ? t("openAgent") : t("viewAgents")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
