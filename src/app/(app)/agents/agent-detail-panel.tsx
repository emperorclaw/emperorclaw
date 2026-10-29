"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import {
    IconRobot,
    IconPlugConnected,
    IconCopy,
    IconCircleCheck,
    IconPlayerPlay,
    IconLoader,
    IconAlertTriangle,
    IconPencil,
    IconRefresh,
    IconHistory,
} from "@tabler/icons-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { runtimeSetupOf } from "@/lib/runtime-setup";
import { providerTroubleLabel, type ProviderTrouble } from "@/lib/provider-trouble";
import { AgentDirectChat } from "@/components/agent-direct-chat";
import { AgentInstructionsTab } from "./agent-instructions-tab";
import { AgentMemoryTab } from "./agent-memory-tab";
import { AvatarPicker } from "@/components/avatar-picker";
import { AgentScopeTab } from "./agent-scope-tab";
import { AgentActionsTab } from "./agent-actions-tab";
import { AgentRunsTab } from "./agent-runs-tab";
import { DeleteAgentDialog } from "./delete-agent-dialog";
import { AgentAccessSettings, LockedAgentCard } from "@/components/access/agent-access-control";
import { getProvider, buildAgentSetupPrompt } from "@/lib/agent-providers";
import { getAgentTemplate } from "@/lib/agent-templates";
import { ModelSearchSelect } from "@/components/model-search-select";
import { SetupOutputLog, type SetupOutputEntry } from "@/components/setup-output-log";
import { cn } from "@/lib/utils";
import { useViewerPermissions } from "@/lib/use-viewer-permissions";
import { BridgeBadge } from "./agent-now-card";
import type { AgentRuntimeInfo } from "@/lib/agent-activity";
import { HERMES_MIGRATION_DOC_HREF } from "@/lib/live-activity";
import { directThreadLink, workLogThreadTitle } from "@/lib/direct-chat-mode";
import { CUSTOM_LLM_PROVIDER } from "@/lib/llm-endpoint";
import { planLlmEndpointEdit } from "@/lib/llm-endpoint-edit";
import { installerDownloadCommand } from "@/lib/runtime-hosts/connect-command";
import { RestartAgentButton } from "@/components/runtime-hosts/restart-agent-button";
import { HostSetupBanner, type ProvisioningView } from "@/components/runtime-hosts/host-setup-banner";


/** A Hermes profile name suggestion for an agent: lowercase, dashes, no spaces. */
function hermesProfileName(agentName: string): string {
    return agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "<profile>";
}
import { toast } from "sonner";
import { useModuleEnabled } from "@/components/modules-provider";

/** Product names; the custom endpoint is labelled by agents.detail.customEndpoint. */
const LLM_PROVIDER_LABELS: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google Gemini",
    openrouter: "OpenRouter",
    grok: "Grok",
    deepseek: "DeepSeek",
};
const PROVIDER_EMOJI: Record<string, string> = { hermes: "👑", openclaw: "🦀", codex: "🧠" };
/** Runtime product names (Generic MCP is labelled by agents.detail.genericMcp). */
const RUNTIME_OPTIONS = [
    { value: "hermes", label: "👑 Hermes" },
    { value: "openclaw", label: "🦀 OpenClaw" },
    { value: "codex", label: "🧠 Codex" },
    { value: "claude", label: "🧠 Claude" },
];
const BASE_URL_EXAMPLE = "http://host.docker.internal:11434/v1";
const AGENT_STATUSES = new Set(["online", "degraded", "offline"]);

type AgentDetailData = {
    /** "metadata": an owner/admin who may not use this agent (lib/agent-access.ts); only name, owner, status and cost come back. */
    access?: "full" | "metadata";
    accessInfo?: { access: string; owner: { id: string; name: string } | null; people: { id: string; name: string }[] } | null;
    directChatMode?: string;
    agent: {
        id: string;
        name: string;
        avatarUrl: string | null;
        avatarAppearance?: import("@/lib/character/model").CharacterAppearance | null;
        role: string;
        status: string;
        memory: string | null;
        provider?: string;
        deploymentMode?: string;
        llmProvider?: string | null;
        llmModel?: string | null;
        lastSeenAt?: string;
        doctrineJson?: Record<string, string>;
        scopeJson?: { mode?: "all" | "restricted"; customerIds?: string[]; projectIds?: string[]; agentIds?: string[] };
        monthlyBudgetCents?: number;
        monthlyTokenUsage?: number;
        budgetStatus?: string;
        containerId?: string | null;
        containerName?: string | null;
        createdAt?: string;
        metadataJson?: unknown;
    };
    /** Set when the agent's latest runs failed on the model provider (it may still be online). */
    providerTrouble?: ProviderTrouble | null;
    /** The paired runtime host it runs on (0.21, Settings -> Runtime hosts). */
    runtimeHost?: { id: string; name: string; status: string; profile: string | null; topology: "standalone" | "shared" | "unknown"; sharedAgents?: number; commands?: string[] } | null;
    /** Its setup on a runtime host (0.22): the latest provision job. */
    provisioning?: ProvisioningView | null;
    latestSnapshot: { id: string; content: string; createdAt: string } | null;
    memoryEntries: Array<{
        id: string;
        kind: string;
        summary: string | null;
        content: string;
        createdAt: string;
    }>;
    sessions: Array<{
        id: string;
        status: string;
        startedAt: string;
        summary: string | null;
        openclawSessionId: string | null;
    }>;
    runs: Array<{
        id: string;
        kind: string;
        status: string;
        startedAt: string;
        summary: string | null;
    }>;
    threads: Array<{
        id: string;
        type: string;
        title: string | null;
        isPrivate?: boolean;
        ownerUserId?: string | null;
        createdAt: string;
        lastMessage: string | null;
    }>;
};

export function AgentDetailPanel({ agentId, agentName, runtime = null }: {
    agentId: string;
    agentName: string;
    /** The agent's Hermes runtime (bridge version badge, shared gateway chip), from the activity poll. */
    runtime?: AgentRuntimeInfo | null;
}) {
    const t = useTranslations("agents.detail");
    const tc = useTranslations("common");
    const tStatus = useTranslations("agents.status");
    const format = useFormatter();
    const llmLabel = (value: string) => value === CUSTOM_LLM_PROVIDER ? t("customEndpoint") : LLM_PROVIDER_LABELS[value] || value;
    // `?tab=scope` (a failure's "Open agent scope" fix) opens that tab.
    const requestedTab = useSearchParams().get("tab");
    const timelineOn = useModuleEnabled("timeline");
    const initialTab = requestedTab && ["memory", "instructions", "scope", "actions", "chat", "threads", "runs"].includes(requestedTab) ? requestedTab : "memory";
    const [data, setData] = useState<AgentDetailData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        if (reloadKey === 0) setLoading(true);
        setError(null);

        fetch(`/api/agents/${agentId}`)
            .then(r => {
                if (!r.ok) throw new Error(r.status === 404 ? t("notFound") : t("loadFailed"));
                return r.json();
            })
            .then(d => {
                if (!cancelled) {
                    setData(d);
                    setLoading(false);
                }
            })
            .catch(e => {
                if (!cancelled) {
                    setError(e.message);
                    setLoading(false);
                }
            });

        return () => { cancelled = true; };
    }, [agentId, reloadKey, t]);

    // ALL hooks must be called before any conditional return
    const [editingProvider, setEditingProvider] = useState(false);
    const [editingDeployment, setEditingDeployment] = useState(false);
    const [editingLlm, setEditingLlm] = useState(false);
    // The model endpoint decides where the agent's key is sent: owners and admins only (the server enforces it too).
    const { canAdmin } = useViewerPermissions();
    const [saving, setSaving] = useState(false);
    // The model endpoint editor's draft. The key is write-only: the saved one is never loaded or shown.
    const [llmDraft, setLlmDraft] = useState({ provider: "", baseUrl: "", apiKey: "", noKey: false, model: "", pendingModel: null as string | null });
    const [llmError, setLlmError] = useState<string | null>(null);
    const [recreating, setRecreating] = useState(false);
    const [confirmRecreate, setConfirmRecreate] = useState(false);
    const [recreateResult, setRecreateResult] = useState<{ success: boolean; message: string; outputs: SetupOutputEntry[] } | null>(null);
    const [pricingOpts, setPricingOpts] = useState<{ model: string; label: string; provider: string; inputPricePer1k: number; outputPricePer1k: number; active: boolean }[]>([]);

    useEffect(() => {
        fetch("/api/ui/pricing").then(r => r.json()).then(d => {
            if (d.pricing) setPricingOpts(d.pricing.map((p: any) => ({
                model: p.model, label: p.label, provider: p.provider,
                inputPricePer1k: p.inputPricePer1k, outputPricePer1k: p.outputPricePer1k,
                active: p.active !== false,
            })));
        }).catch(() => {});
    }, []);

    if (loading) {
        return (
            <main className="emperor-panel rounded-2xl p-6 flex items-center justify-center min-h-[400px]">
                <div className="flex flex-col items-center gap-3 text-zinc-500">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-cyan-400" />
                    <span className="text-sm">{t("loading")}</span>
                </div>
            </main>
        );
    }

    if (error || !data) {
        return (
            <main className="emperor-panel rounded-2xl p-6 flex items-center justify-center min-h-[400px]">
                <div className="text-center text-zinc-500">
                    <IconRobot className="mx-auto h-10 w-10 mb-3 text-zinc-600" />
                    <p className="text-sm">{error || t("couldNotLoad")}</p>
                </div>
            </main>
        );
    }

    if (data.access === "metadata") {
        const locked = data.agent as unknown as { id: string; name: string; role: string | null; status: string; monthlyCostCents: number; access: string };
        return (
            <div className="space-y-3">
                <LockedAgentCard agent={locked} ownerName={data.accessInfo?.owner?.name ?? null} />
                <div className="flex justify-end"><DeleteAgentDialog agentId={locked.id} agentName={locked.name} /></div>
            </div>
        );
    }

    const { agent, sessions, runs, threads, directChatMode } = data;
    // The agent's shared/Operations thread, shown as the "Work log" in private mode.
    const workLogThread = directChatMode === "private" ? threads.find((thread) => thread.type === "direct" && !thread.isPrivate && !thread.ownerUserId) : undefined;
    const provider = getProvider(agent.provider || "mcp");
    // A freshly created agent is legitimately offline while its runtime installs
    // and connects (first boot can take a minute or two). Don't show the red
    // "never connected" warning during that window — it reads as a failure when
    // nothing is wrong yet.
    const startupGraceMs = 3 * 60 * 1000;
    const agentCreatedAtMs = agent.createdAt ? new Date(agent.createdAt).getTime() : 0;
    const withinStartupGrace = agentCreatedAtMs > 0 && Date.now() - agentCreatedAtMs < startupGraceMs;
    // A hire whose container never started is not "starting up": say it failed, with the reason.
    const runtimeSetup = runtimeSetupOf(agent.metadataJson);

    /** PATCH the agent; resolves to the server's error message, or null once saved. */
    const patchAgent = async (fields: Record<string, unknown>): Promise<string | null> => {
        setSaving(true);
        try {
            const res = await fetch(`/api/agents/${agent.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(fields),
            });
            const updated = await res.json().catch(() => ({}));
            if (!res.ok) return updated.error || t("saveFailed");
            setData((prev) => prev ? { ...prev, agent: { ...prev.agent, ...updated.agent } } : prev);
            return null;
        } catch (error) {
            return error instanceof Error ? error.message : t("saveFailed");
        } finally {
            setSaving(false);
        }
    };

    const updateAgent = async (fields: Record<string, unknown>) => {
        const error = await patchAgent(fields);
        if (error) toast.error(error);
        return !error;
    };

    // Model endpoint editor: a provider or base URL change needs that endpoint's key in the same PATCH.
    const startLlmEdit = (provider = agent.llmProvider || "", pendingModel: string | null = null) => {
        setLlmDraft({
            provider,
            baseUrl: "",
            apiKey: "",
            noKey: false,
            model: agent.llmProvider === CUSTOM_LLM_PROVIDER ? agent.llmModel || "" : "",
            pendingModel,
        });
        setLlmError(null);
        setEditingLlm(true);
    };
    const closeLlmEdit = () => {
        setEditingLlm(false);
        setLlmDraft((draft) => ({ ...draft, apiKey: "" }));
        setLlmError(null);
    };
    const llmCustom = llmDraft.provider === CUSTOM_LLM_PROVIDER;
    const llmModelToSave = (): string | undefined => {
        if (llmCustom) return llmDraft.model;
        if (llmDraft.pendingModel !== null) return llmDraft.pendingModel;
        // A custom endpoint's model name means nothing to a named provider: use that provider's default.
        if (agent.llmProvider === CUSTOM_LLM_PROVIDER && llmDraft.provider) return "";
        const configuredModel = pricingOpts.find((option) => option.model === agent.llmModel);
        return configuredModel && llmDraft.provider && configuredModel.provider !== llmDraft.provider ? "" : undefined;
    };
    const llmPlan = planLlmEndpointEdit({
        currentProvider: agent.llmProvider,
        provider: llmDraft.provider,
        baseUrl: llmDraft.baseUrl,
        apiKey: llmDraft.apiKey,
        noKey: llmDraft.noKey,
        model: llmModelToSave(),
    });
    const llmDraftLabel = llmLabel(llmDraft.provider);
    const saveLlm = async () => {
        if (!llmPlan.fields) {
            setLlmError(llmPlan.error);
            return;
        }
        const error = await patchAgent(llmPlan.fields);
        if (error) setLlmError(error);
        else closeLlmEdit();
    };
    const saveLlmOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            event.preventDefault();
            void saveLlm();
        }
    };

    const handleRecreateRuntime = async () => {
        setConfirmRecreate(false);
        setRecreating(true);
        setRecreateResult(null);
        try {
            const res = await fetch(`/api/agents/${agent.id}/recreate-runtime`, { method: "POST" });
            const result = await res.json().catch(() => ({}));
            setRecreateResult({
                success: !!result.success,
                message: result.message || (result.success ? t("recreated") : t("recreateFailed")),
                outputs: result.outputs || [],
            });
            if (result.success) {
                // Started is not online: the status turns Online once Hermes connects.
                toast.success(t("recreatedToast"), { description: t("recreatedToastHint") });
                const refreshed = await fetch(`/api/agents/${agent.id}`).then((r) => r.json()).catch(() => null);
                if (refreshed) setData(refreshed);
            } else {
                toast.error(result.message || t("recreateFailedToast"));
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : t("networkError");
            setRecreateResult({ success: false, message, outputs: [] });
            toast.error(message);
        } finally {
            setRecreating(false);
        }
    };

    return (
        <main className="emperor-panel rounded-2xl overflow-hidden">
            {/* Header */}
            <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5 border-b border-zinc-800/80">
                <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                    <AvatarPicker
                        agentId={agent.id}
                        agentName={agent.name}
                        avatarUrl={agent.avatarUrl ?? null}
                        avatarAppearance={agent.avatarAppearance ?? null}
                        className="h-14 w-14"
                        onSaved={(avatarAppearance, avatarUrl) => setData((prev) => prev ? { ...prev, agent: { ...prev.agent, avatarAppearance, avatarUrl } } : prev)}
                    />
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h2 className="min-w-0 break-words text-xl sm:text-2xl font-semibold text-zinc-100">{agent.name}</h2>
                            <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                                {agent.role || t("operator")}
                            </span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
                            <StatusDot status={agent.status} />
                            <span className="capitalize">{AGENT_STATUSES.has(agent.status) ? tStatus(agent.status as "online") : agent.status}</span>
                            {data.providerTrouble && agent.status !== "offline" && (
                                <span className="text-rose-300" title={data.providerTrouble.headline}>· {providerTroubleLabel(data.providerTrouble.cause)}</span>
                            )}
                            {agent.deploymentMode === "local" && (
                                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300 font-medium">{t("local")}</span>
                            )}
                            {agent.deploymentMode === "remote" && agent.provider && agent.provider !== "mcp" && (
                                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 font-medium">{t("remote")}</span>
                            )}
                            {provider && (
                                <span className="rounded bg-zinc-800/50 px-1.5 py-0.5 text-[10px] text-zinc-400">
                                    {PROVIDER_EMOJI[provider.id] ?? "🔌"} {provider.name}
                                </span>
                            )}
                            {agent.provider === "hermes" && <BridgeBadge runtime={runtime} />}
                            {data.runtimeHost && (
                                <Link href="/settings?tab=runtime-hosts" title={t("hostTitle", { profile: data.runtimeHost.profile ?? "?", topology: data.runtimeHost.topology, status: data.runtimeHost.status })}
                                    className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground">
                                    {data.runtimeHost.status !== "online" ? t("runsOnStatus", { host: data.runtimeHost.name, status: data.runtimeHost.status }) : t("runsOn", { host: data.runtimeHost.name })}
                                </Link>
                            )}
                        </div>
                    </div>
                </div>
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                    {workLogThread && (
                        <Link href={directThreadLink(workLogThread.id, agent.id)} title={t("openWorkLog", { title: workLogThreadTitle(agent.name) })}
                            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-zinc-800 px-3 text-xs text-zinc-300 transition-colors hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-100">
                            {t("workLog")}
                        </Link>
                    )}
                    {timelineOn && (
                        <Link href={`/timeline?agentId=${encodeURIComponent(agent.id)}`} title={t("onTimeline")}
                            className="rounded-full border border-zinc-700 bg-zinc-900/60 p-2 text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-300">
                            <IconHistory className="h-4 w-4" />
                        </Link>
                    )}
                    {agent.containerId && (
                        <ContainerNameDisplay containerName={agent.containerName ?? null} containerId={agent.containerId} />
                    )}
                    {agent.containerId && (
                        <button
                            type="button"
                            disabled={recreating}
                            onClick={() => setConfirmRecreate(true)}
                            title={t("recreateTitle")}
                            className="rounded-full border border-zinc-700 bg-zinc-900/60 p-2 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-colors disabled:opacity-50"
                        >
                            {recreating ? <IconLoader className="h-4 w-4 animate-spin" /> : <IconRefresh className="h-4 w-4" />}
                        </button>
                    )}
                    {data.runtimeHost && canAdmin && (
                        <RestartAgentButton hostId={data.runtimeHost.id} agentId={agent.id} agentName={agent.name}
                            topology={data.runtimeHost.topology} sharedAgents={data.runtimeHost.sharedAgents} hostOnline={data.runtimeHost.status === "online"} />
                    )}
                    <DeleteAgentDialog agentId={agent.id} agentName={agent.name}
                        host={data.runtimeHost ? { name: data.runtimeHost.name, canRemove: canAdmin } : null} />
                </div>
            </div>

            <Dialog open={confirmRecreate} onOpenChange={setConfirmRecreate}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("recreateConfirmTitle", { name: agent.name })}</DialogTitle>
                        <DialogDescription>
                            {t("recreateConfirmBody")}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setConfirmRecreate(false)}>{tc("cancel")}</Button>
                        <Button type="button" onClick={() => void handleRecreateRuntime()} disabled={recreating}>{t("recreate")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Recreate Runtime result — shown inline after the action runs */}
            {recreateResult && (
                <div className={cn(
                    "border-b p-3 sm:p-4 space-y-2",
                    recreateResult.success ? (agent.status === "online" ? "border-emerald-500/20 bg-emerald-500/[0.04]" : "border-zinc-700/60 bg-zinc-900/40") : "border-rose-500/20 bg-rose-500/[0.04]"
                )}>
                    <div className="flex items-center gap-2">
                        {!recreateResult.success ? <IconAlertTriangle className="h-4 w-4 text-rose-400" />
                            : agent.status === "online" ? <IconCircleCheck className="h-4 w-4 text-emerald-400" />
                                : <IconLoader className="h-4 w-4 animate-spin text-zinc-400" />}
                        <span className={cn("text-xs", !recreateResult.success ? "text-rose-200" : agent.status === "online" ? "text-emerald-200" : "text-zinc-300")}>
                            {recreateResult.success && agent.status === "online" ? t("isOnline", { name: agent.name }) : recreateResult.message}
                        </span>
                    </div>
                    <SetupOutputLog outputs={recreateResult.outputs} />
                </div>
            )}

            {/* Set up on a runtime host (0.22): its setup's progress, or Setup failed — Retry / Remove */}
            {data.provisioning && (
                <HostSetupBanner agentId={agent.id} agentName={agent.name} agentStatus={agent.status}
                    hostName={data.provisioning.hostName ?? data.runtimeHost?.name ?? t("itsHost")} provisioning={data.provisioning} canAdmin={canAdmin}
                    onChanged={() => setReloadKey((k) => k + 1)}
                    removeAction={<DeleteAgentDialog agentId={agent.id} agentName={agent.name}
                        host={data.runtimeHost ? { name: data.runtimeHost.name, canRemove: canAdmin } : null}
                        trigger={<Button type="button" size="sm" variant="outline">{tc("remove")}</Button>} />} />
            )}

            {/* Setup banner — only for offline agents that need configuration (not those Emperor sets up on a host) */}
            {agent.status === "offline" && !data.provisioning && (
                <>
                <SetupBanner
                    agentId={agent.id}
                    agentName={agent.name}
                    agentRole={agent.role}
                    agentStatus={agent.status}
                    providerId={agent.provider || "mcp"}
                    deploymentMode={(agent.deploymentMode as "local" | "remote") || "remote"}
                />
                {!agent.lastSeenAt && (
                    runtimeSetup?.status === "failed" && !agent.containerId && agent.provider === "hermes" && agent.deploymentMode === "local" ? (
                        <div role="alert" className="border-b border-rose-500/15 bg-rose-500/[0.04] px-4 py-2 text-xs text-rose-200">
                            {t("setupFailed", { message: runtimeSetup.message })}
                        </div>
                    ) : withinStartupGrace ? (
                        <div className="border-b border-amber-500/15 bg-amber-500/[0.04] px-4 py-2 text-[10px] text-amber-200/80">
                            {t("startingUp")}
                        </div>
                    ) : (
                        <div className="border-b border-rose-500/15 bg-rose-500/[0.04] px-4 py-2 text-[10px] text-rose-300/70">
                            {t("neverConnected")}
                            {agent.provider === "hermes" ? ` ${t("seeGuideBelow")}` : ""}
                        </div>
                    )
                )}
                </>
            )}

            {/* Runtime and model configuration stays editable before the first connection, too. */}
            <div className={cn(
                "border-b px-4 sm:px-5 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-xs",
                agent.status === "offline"
                    ? "border-zinc-800 bg-zinc-950/40"
                    : "border-emerald-500/10 bg-emerald-500/[0.03]",
            )}>
                    {/* Provider — editable */}
                    <span className="text-zinc-500 inline-flex items-center gap-1.5">
                        {t("providerLabel")}{" "}
                        {editingProvider ? (
                            <select
                                value={agent.provider || "mcp"}
                                disabled={saving}
                                onChange={(e) => {
                                    updateAgent({ provider: e.target.value });
                                    setEditingProvider(false);
                                }}
                                onBlur={() => setEditingProvider(false)}
                                className="h-6 rounded border border-zinc-700 bg-zinc-900 px-1.5 text-xs text-zinc-200 outline-none focus:border-cyan-400"
                                autoFocus
                            >
                                <option disabled={agent.deploymentMode === "local"} value="mcp">{t("genericMcp")}</option>
                                {RUNTIME_OPTIONS.map((option) => (
                                    <option key={option.value} disabled={option.value !== "hermes" && agent.deploymentMode === "local"} value={option.value}>{option.label}</option>
                                ))}
                            </select>
                        ) : (
                            <>
                                <span className="text-zinc-300 font-medium">{(provider && PROVIDER_EMOJI[provider.id]) ?? "🔌"} {provider?.name || t("genericMcpName")}</span>
                                <button type="button" onClick={() => setEditingProvider(true)} className="text-zinc-600 hover:text-zinc-400 transition-colors" title={t("changeProvider")}>
                                    <IconPencil className="h-3 w-3" />
                                </button>
                            </>
                        )}
                    </span>
                    {/* Deployment mode — editable */}
                    <span className="text-zinc-500 inline-flex items-center gap-1.5">
                        {t("deploymentLabel")}{" "}
                        {editingDeployment ? (
                            <select
                                value={agent.deploymentMode || "remote"}
                                disabled={saving}
                                onChange={(e) => {
                                    updateAgent({ deploymentMode: e.target.value });
                                    setEditingDeployment(false);
                                }}
                                onBlur={() => setEditingDeployment(false)}
                                className="h-6 rounded border border-zinc-700 bg-zinc-900 px-1.5 text-xs text-zinc-200 outline-none focus:border-cyan-400"
                                autoFocus
                            >
                                <option value="remote">{t("remote")}</option>
                                <option disabled={agent.provider !== "hermes"} value="local">{t("localThisServer")}</option>
                            </select>
                        ) : (
                            <>
                                <span className="text-zinc-300 font-medium">{agent.deploymentMode === "local" ? t("local") : t("remote")}</span>
                                <button type="button" onClick={() => setEditingDeployment(true)} className="text-zinc-600 hover:text-zinc-400 transition-colors" title={t("changeDeployment")}>
                                    <IconPencil className="h-3 w-3" />
                                </button>
                            </>
                        )}
                    </span>
                    {/* LLM Provider — owners/admins edit it; a new endpoint's key is asked for below the bar */}
                    <span className="text-zinc-500 inline-flex items-center gap-1.5">
                        {t("llmLabel")}{" "}
                        {editingLlm && canAdmin ? (
                            <span className="inline-flex items-center gap-1.5">
                                <select
                                    value={llmDraft.provider}
                                    disabled={saving}
                                    aria-label={t("llmProvider")}
                                    onChange={(e) => {
                                        const nextProvider = e.target.value;
                                        setLlmDraft((draft) => ({ ...draft, provider: nextProvider, pendingModel: null }));
                                        setLlmError(null);
                                    }}
                                    className="h-6 rounded border border-zinc-700 bg-zinc-900 px-1.5 text-xs text-zinc-200 outline-none focus:border-cyan-400"
                                >
                                    <option value="">{t("none")}</option>
                                    {Object.entries(LLM_PROVIDER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                                    <option value={CUSTOM_LLM_PROVIDER}>{t("customEndpoint")}</option>
                                </select>
                                <button
                                    type="button"
                                    disabled={saving}
                                    onClick={() => void saveLlm()}
                                    className="text-[10px] text-cyan-400 hover:text-cyan-300 font-medium disabled:opacity-50"
                                >
                                    {tc("save")}
                                </button>
                                <button
                                    type="button"
                                    onClick={closeLlmEdit}
                                    className="text-zinc-600 hover:text-zinc-400 text-[10px]"
                                >
                                    {tc("cancel")}
                                </button>
                            </span>
                        ) : (
                            <>
                                <span className="text-zinc-300 font-medium">
                                    {agent.llmProvider ? llmLabel(agent.llmProvider) : t("none")}
                                </span>
                                {canAdmin && <button type="button" onClick={() => startLlmEdit()} className="text-zinc-600 hover:text-zinc-400 transition-colors" title={t("configureLlm")}>
                                    <IconPencil className="h-3 w-3" />
                                </button>}
                                {agent.llmProvider && (
                                    <a href="/docs/v1.1/troubleshooting#5-agent-setup--llm-configuration" target="_blank" className="text-[9px] text-cyan-400 hover:text-cyan-300 underline underline-offset-2" title={t("setupGuideTitle")}>
                                        {t("setupGuide")}
                                    </a>
                                )}
                            </>
                        )}
                    </span>
                    {/* Model selector — uses pricing table for cost tracking */}
                    <span className="text-zinc-500 inline-flex items-center gap-1.5">
                        {t("modelLabel")}{" "}
                        {/* A custom endpoint serves its own model names; the priced catalog would call them unavailable. */}
                        {data.agent.llmProvider === "custom" || !canAdmin ? <span className="font-medium text-zinc-300">{data.agent.llmModel || "—"}</span> : <ModelSearchSelect
                            options={pricingOpts}
                            value={data.agent.llmModel || ""}
                            provider={data.agent.llmProvider || ""}
                            disabled={saving}
                            saving={saving}
                            compact
                            onChange={async (selection) => {
                                // A model of another provider moves the agent to that provider's endpoint: ask for its key first.
                                if (selection.provider && selection.provider !== (agent.llmProvider || "")) {
                                    startLlmEdit(selection.provider, selection.model);
                                    return;
                                }
                                await updateAgent({
                                    llmProvider: selection.provider,
                                    llmModel: selection.model,
                                });
                            }}
                        />}
                    </span>
                    {agent.lastSeenAt && (
                        <span className="text-zinc-500">
                            {t("lastSeen")} <span className="text-zinc-300 font-medium">{format.dateTime(new Date(agent.lastSeenAt), { timeStyle: "medium" })}</span>
                        </span>
                    )}
                    {(agent.monthlyBudgetCents ?? 0) > 0 && (
                        <span className={cn(
                            "font-medium",
                            agent.budgetStatus === "paused" ? "text-rose-400" :
                            agent.budgetStatus === "warning" ? "text-amber-400" : "text-emerald-400"
                        )}>
                            {t("budget", { used: ((agent.monthlyTokenUsage ?? 0) / 1_000_000 * 1).toFixed(2), limit: ((agent.monthlyBudgetCents ?? 0) / 100).toFixed(0) })}
                            {agent.budgetStatus === "paused" ? " ⏸️" : agent.budgetStatus === "warning" ? " ⚠️" : ""}
                        </span>
                    )}
            </div>

            {editingLlm && canAdmin && (llmPlan.keyRequired || llmCustom || llmError) && (
                <div className="border-b border-border bg-muted/40 px-4 sm:px-5 py-3 space-y-2.5 text-xs">
                    {llmDraft.pendingModel && (
                        <p className="text-muted-foreground">
                            {t("pendingModel", { model: llmDraft.pendingModel, provider: llmDraftLabel })}
                        </p>
                    )}
                    <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
                        {llmCustom && (
                            <label className="space-y-1">
                                <span className="block font-medium text-foreground">{t("baseUrl")}</span>
                                <input
                                    type="url"
                                    value={llmDraft.baseUrl}
                                    onChange={(e) => { const baseUrl = e.target.value; setLlmDraft((draft) => ({ ...draft, baseUrl })); setLlmError(null); }}
                                    onKeyDown={saveLlmOnEnter}
                                    disabled={saving}
                                    placeholder={BASE_URL_EXAMPLE}
                                    autoComplete="off"
                                    className="block w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-cyan-500"
                                />
                                <span className="block text-muted-foreground">
                                    {llmPlan.baseUrlHint
                                        ?? `${agent.llmProvider === CUSTOM_LLM_PROVIDER ? `${t("keepUrl")} ` : ""}${t("dockerHostHint")}`}
                                </span>
                            </label>
                        )}
                        {llmCustom && (
                            <label className="space-y-1">
                                <span className="block font-medium text-foreground">{t("model")}</span>
                                <input
                                    value={llmDraft.model}
                                    onChange={(e) => { const model = e.target.value; setLlmDraft((draft) => ({ ...draft, model })); setLlmError(null); }}
                                    onKeyDown={saveLlmOnEnter}
                                    disabled={saving}
                                    maxLength={200}
                                    placeholder={t("customModelPlaceholder")}
                                    autoComplete="off"
                                    className="block w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-cyan-500"
                                />
                            </label>
                        )}
                        {llmPlan.keyRequired && (
                            <div className="space-y-1">
                                <label htmlFor={`llm-key-${agent.id}`} className="block font-medium text-foreground">{t("apiKeyFor", { provider: llmDraftLabel })}</label>
                                <input
                                    id={`llm-key-${agent.id}`}
                                    type="password"
                                    value={llmDraft.apiKey}
                                    onChange={(e) => { const apiKey = e.target.value; setLlmDraft((draft) => ({ ...draft, apiKey })); setLlmError(null); }}
                                    onKeyDown={saveLlmOnEnter}
                                    disabled={saving || (llmCustom && llmDraft.noKey)}
                                    placeholder={llmCustom && llmDraft.noKey ? t("noKey") : t("pasteKey")}
                                    autoComplete="off"
                                    className="block w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-cyan-500 disabled:opacity-60"
                                />
                                {llmCustom && (
                                    <label className="flex items-center gap-1.5 text-muted-foreground">
                                        <input
                                            type="checkbox"
                                            checked={llmDraft.noKey}
                                            disabled={saving}
                                            onChange={(e) => { const noKey = e.target.checked; setLlmDraft((draft) => ({ ...draft, noKey, apiKey: noKey ? "" : draft.apiKey })); setLlmError(null); }}
                                        />
                                        {t("needsNoKey")}
                                    </label>
                                )}
                                <span className="block text-muted-foreground">{t("keyNeverShown")}</span>
                            </div>
                        )}
                    </div>
                    {llmError && <p role="alert" className="text-destructive">{llmError}</p>}
                </div>
            )}

            {/* Tabs */}
            <Tabs key={initialTab} defaultValue={initialTab} className="p-4 sm:p-5">
                {/* Seven tabs outgrow a phone: the strip scrolls sideways instead of overflowing the panel. */}
                <div className="-mx-1 max-w-full overflow-x-auto px-1 pb-1">
                    <TabsList className="w-max bg-zinc-900 border border-zinc-800">
                        <TabsTrigger value="memory">{t("tabs.memory")}</TabsTrigger>
                        <TabsTrigger value="instructions">{t("tabs.instructions")}</TabsTrigger>
                        <TabsTrigger value="scope">{t("tabs.scope")}</TabsTrigger>
                        <TabsTrigger value="actions">{t("tabs.actions")}</TabsTrigger>
                        <TabsTrigger value="chat">{t("tabs.chat")}</TabsTrigger>
                        <TabsTrigger value="threads">{t("tabs.threads")}</TabsTrigger>
                        <TabsTrigger value="runs">{t("tabs.runs")}</TabsTrigger>
                    </TabsList>
                </div>

                <TabsContent value="memory" className="mt-4">
                    <AgentMemoryTab agentId={agent.id} agentName={agent.name} />
                </TabsContent>

                <TabsContent value="instructions" className="mt-4">
                    <AgentInstructionsTab
                        agentId={agent.id}
                        initialDoctrine={agent.doctrineJson || {}}
                    />
                </TabsContent>

                <TabsContent value="scope" className="mt-4 space-y-4">
                    <AgentAccessSettings agentId={agent.id} />
                    <AgentScopeTab
                        agentId={agent.id}
                        agentName={agent.name}
                        initialScope={agent.scopeJson}
                    />
                </TabsContent>

                <TabsContent value="actions" className="mt-4">
                    <AgentActionsTab agentId={agent.id} agentName={agent.name} />
                </TabsContent>

                <TabsContent value="chat" className="mt-4">
                    <AgentDirectChat agentId={agent.id} agentName={agent.name} />
                </TabsContent>

                <TabsContent value="threads" className="mt-4">
                    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
                        <div className="flex items-center gap-2 mb-3">
                            <IconPlugConnected className="w-4 h-4 text-cyan-400" />
                            <h3 className="text-sm font-medium text-zinc-200">{t("threads")}</h3>
                        </div>
                        <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                            {threads.length === 0 ? (
                                <EmptyState text={t("noThreads")} />
                            ) : threads.map(thread => (
                                <div key={thread.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                                    <div className="flex items-center justify-between gap-2 mb-1">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] uppercase tracking-wider font-bold text-cyan-400">{thread.type}</span>
                                            <span className="text-xs text-zinc-200">{thread.title || t("untitledThread")}</span>
                                        </div>
                                        <span className="text-[10px] text-zinc-600">{format.dateTime(new Date(thread.createdAt), { dateStyle: "medium", timeStyle: "short" })}</span>
                                    </div>
                                    <div className="text-[11px] text-zinc-500 line-clamp-2">
                                        {thread.lastMessage || t("noMessages")}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </TabsContent>

                <TabsContent value="runs" className="mt-4 space-y-4">
                    <AgentRunsTab agentId={agent.id} />
                    <SessionsAndActions sessions={sessions} runs={runs} />
                </TabsContent>
            </Tabs>
        </main>
    );
}

function ContainerNameDisplay({ containerName, containerId }: { containerName: string | null; containerId: string }) {
    const t = useTranslations("agents.detail");
    const [copied, setCopied] = useState(false);
    const display = containerName || containerId.slice(0, 12);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(display);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <span
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/60 px-2.5 py-1 text-[10px] text-zinc-500"
            title={t("containerTitle")}
        >
            <span className="font-mono text-zinc-400 truncate max-w-[180px]">{display}</span>
            <button
                type="button"
                onClick={handleCopy}
                title={t("copyContainer")}
                className="text-zinc-600 hover:text-zinc-300 transition-colors"
            >
                {copied ? <IconCircleCheck className="h-3 w-3 text-emerald-400" /> : <IconCopy className="h-3 w-3" />}
            </button>
        </span>
    );
}

function StatusDot({ status }: { status: string }) {
    const color = {
        online: "bg-emerald-500",
        degraded: "bg-amber-500",
        offline: "bg-zinc-600",
    }[status] || "bg-zinc-600";
    return <span className={cn("h-2 w-2 rounded-full shrink-0", color)} />;
}

// Kept alongside the new Runs tab: agent sessions and action runs are live,
// distinct from runtime turns. They are always rendered, so the Runs empty
// state can never hide them.
function SessionsAndActions({ sessions, runs }: { sessions: AgentDetailData["sessions"]; runs: AgentDetailData["runs"] }) {
    const t = useTranslations("agents.detail");
    const format = useFormatter();
    const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
    return (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
                <IconPlugConnected className="w-4 h-4 text-cyan-400" />
                <h3 className="text-sm font-medium text-zinc-200">{t("sessionsTitle")}</h3>
            </div>
            <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                {runs.length === 0 && sessions.length === 0 ? (
                    <EmptyState text={t("noSessions")} />
                ) : (
                    <>
                        {sessions.map(session => (
                            <div key={session.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                                <div className="flex items-center justify-between gap-2 mb-1">
                                    <span className="text-[10px] uppercase tracking-wider font-bold text-emerald-400">{t("session")}</span>
                                    <span className="text-[10px] text-zinc-600">{when(session.startedAt)}</span>
                                </div>
                                <div className="text-xs text-zinc-200">{session.status}</div>
                                {session.openclawSessionId && (
                                    <div className="text-[10px] text-zinc-500 mt-1 font-mono truncate">{session.openclawSessionId}</div>
                                )}
                                {session.summary && <div className="text-[11px] text-zinc-400 mt-1 line-clamp-2">{session.summary}</div>}
                            </div>
                        ))}
                        {runs.map(run => (
                            <div key={run.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                                <div className="flex items-center justify-between gap-2 mb-1">
                                    <span className="text-[10px] uppercase tracking-wider font-bold text-cyan-400">{run.kind}</span>
                                    <span className="text-[10px] text-zinc-600">{when(run.startedAt)}</span>
                                </div>
                                <div className="text-xs text-zinc-200">{run.status}</div>
                                {run.summary && <div className="text-[11px] text-zinc-400 mt-1 line-clamp-2">{run.summary}</div>}
                            </div>
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}

function EmptyState({ text }: { text: string }) {
    return (
        <div className="rounded-lg border border-dashed border-zinc-800 p-6 text-center">
            <p className="text-xs text-zinc-500">{text}</p>
        </div>
    );
}

function SetupBanner({ agentId, agentName, agentRole, agentStatus, providerId, deploymentMode }: { agentId: string; agentName: string; agentRole: string; agentStatus: string; providerId: string; deploymentMode: "local" | "remote" }) {
    const t = useTranslations("agents.setup");
    const [copied, setCopied] = useState(false);
    const [copiedCmd, setCopiedCmd] = useState(false);
    const [setupRunning, setSetupRunning] = useState(false);
    const [setupResult, setSetupResult] = useState<{ success: boolean; message: string; outputs?: { command: string; stdout: string; stderr: string; exitCode: number | null }[] } | null>(null);
    // A freshly-minted access token, injected into the connect commands so the
    // user doesn't have to go create one and paste it in. Shown once.
    const [genToken, setGenToken] = useState<string | null>(null);
    const [genningToken, setGenningToken] = useState(false);
    const [genTokenError, setGenTokenError] = useState<string | null>(null);
    const provider = getProvider(providerId) || getProvider("mcp")!;
    const isLocal = deploymentMode === "local";
    const isOnline = agentStatus === "online";

    // Substitute template vars. Uses the generated token when available, else a
    // clear placeholder that tells the user to create one.
    const tokenValue = genToken ?? "YOUR_TOKEN";
    const applyVars = (s: string) => s
        .replace(/\{name\}/g, agentName)
        .replace(/\{role\}/g, agentRole)
        .replace(/\{token\}/g, tokenValue);

    const generateToken = async () => {
        setGenningToken(true);
        setGenTokenError(null);
        try {
            const res = await fetch("/api/settings/tokens", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: `agent: ${agentName}`, scope: "mcp_full" }),
            });
            const body = await res.json();
            if (!res.ok || !body.secret) throw new Error(body.error || t("tokenFailed"));
            setGenToken(body.secret as string);
        } catch (e) {
            setGenTokenError(e instanceof Error ? e.message : t("tokenFailed"));
        } finally {
            setGenningToken(false);
        }
    };
    const template = getAgentTemplate(
        Object.entries({
            "SEO Specialist": "seo",
            "Technical Developer": "developer",
            "QA & Testing Agent": "qa",
            "Growth & Lead Gen": "growth",
            "Content & Copywriter": "content",
            "Accountant & Bookkeeper": "accountant",
            "Customer Support": "support",
            "Data Analyst": "analyst",
        }).find(([title]) => agentRole?.includes(title))?.[1] || ""
    );

    const setupPrompt = template
        ? buildAgentSetupPrompt(template, provider, typeof window !== "undefined" ? window.location.origin : "http://localhost:3000")
        : `Set up a ${agentRole} agent using ${provider.name}. See the Instructions tab for doctrine files.`;

    const handleCopy = async () => {
        await navigator.clipboard.writeText(setupPrompt);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    if (providerId === "hermes" && isLocal) return (
        <div className="border-b border-emerald-500/20 bg-emerald-500/[0.06] p-4 space-y-3">
            <h3 className="text-sm font-semibold text-emerald-100">{t("startLocal")}</h3>
            <p className="text-xs text-zinc-400">{t("startLocalHint")}</p>
            <button type="button" disabled={setupRunning} onClick={async () => {
                setSetupRunning(true); setSetupResult(null);
                try {
                    const response = await fetch(`/api/agents/${agentId}/recreate-runtime`, { method: "POST" });
                    const data = await response.json();
                    setSetupResult(response.ok ? data : { success: false, message: data.error || t("setupFailed") });
                    if (response.ok && data.success) setTimeout(() => window.location.reload(), 2000);
                } catch (e) { setSetupResult({ success: false, message: e instanceof Error ? e.message : t("setupFailed") }); }
                finally { setSetupRunning(false); }
            }} className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-4 py-2 text-sm text-emerald-200 disabled:opacity-50">
                {setupRunning ? t("startingHermes") : t("retryLocal")}
            </button>
            {setupResult && <div className="space-y-2 text-xs" role="status">
                <p className={setupResult.success ? "text-emerald-300" : "text-rose-300"}>{setupResult.message}</p>
                {setupResult.outputs && <SetupOutputLog outputs={setupResult.outputs} />}
            </div>}
        </div>
    );

    return (
        <div className={cn(
            "border-b p-4 sm:p-5 space-y-4",
            isLocal
                ? "border-emerald-500/20 bg-emerald-500/[0.06]"
                : "border-amber-500/20 bg-amber-500/[0.06]"
        )}>
            <div className="flex items-start gap-3">
                <span className="text-xl mt-0.5" aria-hidden="true">{isLocal ? "🖥️" : "🚀"}</span>
                <div className="flex-1">
                    <h3 className={cn("text-sm font-semibold", isLocal ? "text-emerald-100" : "text-amber-100")}>
                        {isOnline
                            ? t("isRunning", { name: agentName })
                            : isLocal ? t("createdConnectHere") : t("createdConnect")
                        }
                    </h3>
                    <p className={cn("text-xs mt-1", isLocal ? "text-emerald-100/70" : "text-amber-100/70")}>
                        {isOnline
                            ? t("onlineProcessing", { name: agentName, provider: provider.name })
                            : isLocal
                                ? t("configuredLocal", { name: agentName, role: agentRole, provider: provider.name })
                                : t("configuredRemote", { name: agentName, role: agentRole, provider: provider.name })
                        }
                    </p>
                </div>
            </div>

            {/* Auto-setup button — Hermes local mode only */}
            {providerId === "hermes" && isLocal && (
                <div className="space-y-3">
                    <button
                        type="button"
                        disabled={setupRunning}
                        onClick={async () => {
                            setSetupRunning(true);
                            setSetupResult(null);
                            try {
                                const res = await fetch(`/api/agents/${agentId}/setup-local`, { method: "POST" });
                                const data = await res.json();
                                setSetupResult(data);
                                if (data.success) {
                                    // Reload after 2s so user sees success, then banner hides
                                    setTimeout(() => window.location.reload(), 2000);
                                }
                            } catch (e) {
                                setSetupResult({ success: false, message: e instanceof Error ? e.message : t("networkError") });
                            } finally {
                                setSetupRunning(false);
                            }
                        }}
                        className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-4 py-2.5 text-sm font-medium text-emerald-200 hover:bg-emerald-500/25 transition-colors disabled:opacity-50"
                    >
                        {setupRunning ? (
                            <><IconLoader className="h-4 w-4 animate-spin" />{t("settingUpHermes")}</>
                        ) : (
                            <><IconPlayerPlay className="h-4 w-4" />{t("autoSetup")}</>
                        )}
                    </button>

                    {setupResult && (
                        <div className={`rounded-lg border p-3 text-xs space-y-2 ${setupResult.success ? "border-emerald-500/20 bg-emerald-500/[0.06]" : "border-rose-500/20 bg-rose-500/[0.06]"}`}>
                            <div className="flex items-center gap-2">
                                {setupResult.success ? <IconCircleCheck className="h-4 w-4 text-emerald-400" /> : <IconAlertTriangle className="h-4 w-4 text-rose-400" />}
                                <span className={setupResult.success ? "text-emerald-200" : "text-rose-200"}>{setupResult.message}</span>
                            </div>
                            {setupResult.outputs && setupResult.outputs.length > 0 && (
                                <SetupOutputLog outputs={setupResult.outputs} />
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Setup guide — Hermes-specific */}
            {providerId === "hermes" && !isOnline && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 space-y-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">{t("whatToDo")}</span>
                    <ol className="space-y-1.5 text-[11px] text-amber-100/80 list-decimal list-inside">
                        <li className="break-words">
                            {t("stepDownload")}
                            <code className="mt-1 block overflow-x-auto whitespace-pre-wrap break-all rounded bg-amber-500/10 px-2 py-1 text-amber-200">{installerDownloadCommand()}</code>
                        </li>
                        <li className="break-words">
                            {t.rich("stepProfile", { command: `hermes profile create ${hermesProfileName(agentName)} --clone`, file: ".env", code: (chunks) => <code className="text-amber-200 bg-amber-500/10 px-1 rounded">{chunks}</code>, file1: (chunks) => <code className="text-amber-200/80">{chunks}</code> })}
                        </li>
                        <li className="break-words">
                            {t.rich("stepInstall", { command: `~/.local/bin/emperor-hermes install --profile ${hermesProfileName(agentName)}`, code: (chunks) => <code className="text-amber-200 bg-amber-500/10 px-1 rounded">{chunks}</code> })}
                            <span className="block text-amber-100/60">{t("stepConnectHost")}</span>
                        </li>
                    </ol>
                    <p className="text-[10px] text-amber-100/60 mt-2">
                        {t.rich("migration", {
                            guide: (chunks) => <a href={HERMES_MIGRATION_DOC_HREF} target="_blank" rel="noreferrer" className="text-cyan-400 underline underline-offset-2 hover:text-cyan-300">{chunks}</a>,
                            full: (chunks) => <a href="/docs/v1.1/hermes-runtime" target="_blank" rel="noreferrer" className="text-cyan-400 underline underline-offset-2 hover:text-cyan-300">{chunks}</a>,
                            online: (chunks) => <span className="text-emerald-300">{chunks}</span>,
                        })}
                    </p>
                </div>
            )}

            {/* Direct install commands — for providers that have them */}
            {provider.installCommands.length > 0 && (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-200">
                            {t("quickConnect")}
                        </span>
                        <div className="flex items-center gap-1.5">
                            {!genToken && (
                                <button
                                    type="button"
                                    onClick={generateToken}
                                    disabled={genningToken}
                                    className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 px-3 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/15 transition-colors disabled:opacity-50"
                                >
                                    {genningToken ? t("generating") : t("generateToken")}
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={async () => {
                                    const cmds = provider.installCommands.map(applyVars).join("\n");
                                    await navigator.clipboard.writeText(cmds);
                                    setCopiedCmd(true);
                                    setTimeout(() => setCopiedCmd(false), 2000);
                                }}
                                className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 px-3 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/15 transition-colors"
                            >
                                {copiedCmd ? <IconCircleCheck className="h-3 w-3" /> : <IconCopy className="h-3 w-3" />}
                                {copiedCmd ? t("copied") : t("copyAll")}
                            </button>
                        </div>
                    </div>
                    <div className="p-3 space-y-2">
                        {provider.installCommands.map((cmd, i) => (
                            <div key={i} className="flex items-start gap-2">
                                <span className="text-[10px] text-emerald-500 mt-0.5 shrink-0">{i + 1}.</span>
                                <code className="text-[11px] text-emerald-100/80 font-mono break-all">
                                    {applyVars(cmd)}
                                </code>
                            </div>
                        ))}
                        {genToken ? (
                            <p className="text-[10px] text-emerald-200/90 mt-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 px-2 py-1.5">
                                {t("tokenInserted")}
                            </p>
                        ) : genTokenError ? (
                            <p className="text-[10px] text-rose-300/90 mt-1">{t("tokenError", { error: genTokenError })}</p>
                        ) : (
                            <p className="text-[10px] text-emerald-100/50 mt-1">
                                {t.rich("tokenHint", { placeholder: "YOUR_TOKEN", strong: (chunks) => <span className="text-emerald-200">{chunks}</span>, code: (chunks) => <code className="text-emerald-200/80">{chunks}</code> })}
                            </p>
                        )}
                        <p className="text-[10px] text-emerald-100/50 mt-1">
                            {isLocal
                                ? t("assumesLocal", { provider: provider.name })
                                : t("assumesRemote", { provider: provider.name })
                            }
                        </p>
                    </div>
                </div>
            )}

            {/* Setup prompt — always show for remote, optional for local */}
            <div className={cn(
                "rounded-xl border bg-zinc-950/60 overflow-hidden",
                isLocal
                    ? "border-emerald-500/20"
                    : "border-amber-500/20"
            )}>
                <div className={cn(
                    "flex items-center justify-between px-4 py-2 border-b",
                    isLocal
                        ? "bg-emerald-500/10 border-emerald-500/20"
                        : "bg-amber-500/10 border-amber-500/20"
                )}>
                    <span className={cn("text-[10px] font-bold uppercase tracking-wider", isLocal ? "text-emerald-200" : "text-amber-200")}>
                        {isLocal ? t("promptOptional") : t("prompt")}
                    </span>
                    <button
                        type="button"
                        onClick={handleCopy}
                        className={cn(
                            "flex items-center gap-1.5 rounded-lg border px-3 py-1 text-[11px] font-medium transition-colors",
                            isLocal
                                ? "border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/15"
                                : "border-amber-500/30 text-amber-200 hover:bg-amber-500/15"
                        )}
                    >
                        {copied ? <IconCircleCheck className="h-3 w-3" /> : <IconCopy className="h-3 w-3" />}
                        {copied ? t("copied") : t("copyPrompt")}
                    </button>
                </div>
                <pre className={cn("p-4 text-[11px] whitespace-pre-wrap max-h-[200px] overflow-y-auto font-mono leading-relaxed select-all", isLocal ? "text-emerald-100/80" : "text-amber-100/80")}>
                    {setupPrompt}
                </pre>
            </div>

            {/* Bridge config generator — Hermes only */}
            {providerId === "hermes" && (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3 space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-200">
                            {t("bridgeConfig")}
                        </span>
                        <button
                            type="button"
                            onClick={async () => {
                                const baseUrl = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
                                const env = [
                                    `EMPEROR_CLAW_API_URL="${baseUrl}"`,
                                    `EMPEROR_CLAW_API_TOKEN="${genToken ?? "<generate in Settings > Access Tokens>"}"`,
                                    `EMPEROR_CLAW_AGENT_NAME="${agentName}"`,
                                    `EMPEROR_CLAW_AGENT_ID="${agentId}"`,
                                    `EMPEROR_CLAW_AGENT_ROLE="${agentRole}"`,
                                    `HERMES_TOOLSETS="emperor-claw,web,terminal,code_execution"`,
                                    `HERMES_BIN="hermes"`,
                                    `EMPEROR_CLAW_HERMES_POLL_SECONDS="5"`,
                                    `DEEPSEEK_API_KEY="<your-api-key>"`,
                                ].join("\n");
                                await navigator.clipboard.writeText(env);
                                setCopiedCmd(true);
                                setTimeout(() => setCopiedCmd(false), 2000);
                            }}
                            className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 px-3 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/15 transition-colors"
                        >
                            {copiedCmd ? <IconCircleCheck className="h-3 w-3" /> : <IconCopy className="h-3 w-3" />}
                            {copiedCmd ? t("copied") : t("copyEnv")}
                        </button>
                    </div>
                    <p className="text-[10px] text-emerald-100/60">
                        {t.rich("saveEnv", { path: `~/.hermes/emperor-bridge/${agentName}/.env`, code: (chunks) => <code className="text-emerald-200/80 bg-emerald-500/5 px-1 rounded">{chunks}</code>, strong: (chunks) => <strong>{chunks}</strong> })}
                    </p>
                </div>
            )}

            {/* Checklist */}
            <div className="space-y-2">
                <span className={cn("text-[10px] font-bold uppercase tracking-wider", isLocal ? "text-emerald-300" : "text-amber-300")}>
                    {t("checklist")}
                </span>
                <div className="grid gap-1.5">
                    {provider.postInstallChecklist.map((step, i) => (
                        <div key={i} className={cn("flex items-center gap-2 text-[11px]", isLocal ? "text-emerald-100/70" : "text-amber-100/70")}>
                            <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]", isLocal ? "border-emerald-500/30 text-emerald-300" : "border-amber-500/30 text-amber-300")}>
                                {i + 1}
                            </span>
                            <span>{applyVars(step)}</span>
                        </div>
                    ))}
                    <div className={cn("flex items-center gap-2 text-[11px]", isLocal ? "text-emerald-100/70" : "text-amber-100/70")}>
                        <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]", isLocal ? "border-emerald-500/30 text-emerald-300" : "border-amber-500/30 text-amber-300")}>
                            {"✓"}
                        </span>
                        <span>{t.rich("checkDashboard", { name: agentName, strong: (chunks) => <strong>{chunks}</strong> })}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
