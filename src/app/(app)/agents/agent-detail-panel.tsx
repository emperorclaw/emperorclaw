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
    IconLoader,
    IconAlertTriangle,
    IconPencil,
    IconRefresh,
    IconHistory,
    IconDots,
    IconTrash,
} from "@tabler/icons-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { runtimeSetupOf } from "@/lib/runtime-setup";
import { providerTroubleHeadlineCopy, providerTroubleLabel, providerTroubleLabelCopy, type ProviderTrouble } from "@/lib/provider-trouble";
import { useCopy } from "@/lib/i18n/use-copy";
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
import { Select } from "@/components/ui/select";


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

/** Field labels reuse the existing "Label:" copy without the trailing colon. */
function fieldLabel(value: string): string {
    return value.replace(/\s*[:：]\s*$/, "");
}

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
        /** Agent messages this viewer has not read yet. */
        unreadCount?: number;
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
    const tCreate = useTranslations("agents.create");
    const tModel = useTranslations("modelSelect");
    const tStatus = useTranslations("agents.status");
    const tDelete = useTranslations("agents.delete");
    const render = useCopy();
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
    const [editingModel, setEditingModel] = useState(false);
    // The model endpoint decides where the agent's key is sent: owners and admins only (the server enforces it too).
    const { canAdmin } = useViewerPermissions();
    const [saving, setSaving] = useState(false);
    // The model endpoint editor's draft. The key is write-only: the saved one is never loaded or shown.
    const [llmDraft, setLlmDraft] = useState({ provider: "", baseUrl: "", apiKey: "", noKey: false, model: "", pendingModel: null as string | null });
    const [llmError, setLlmError] = useState<string | null>(null);
    const [recreating, setRecreating] = useState(false);
    const [confirmRecreate, setConfirmRecreate] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
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
            <main className="ec-skeleton-in emperor-panel rounded-2xl p-6 flex items-center justify-center min-h-[400px]">
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
        <main className="ec-appear emperor-panel rounded-2xl overflow-hidden">
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
                                <span className="text-rose-300" title={render(providerTroubleHeadlineCopy(data.providerTrouble.cause), data.providerTrouble.headline)}>· {render(providerTroubleLabelCopy(data.providerTrouble.cause), providerTroubleLabel(data.providerTrouble.cause))}</span>
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
                            {(workLogThread.unreadCount ?? 0) > 0 && (
                                <span className="min-w-5 rounded-full bg-cyan-400 px-1.5 py-0.5 text-center text-[10px] font-bold text-cyan-950">
                                    <span aria-hidden="true">{workLogThread.unreadCount}</span>
                                    <span className="sr-only">{t("workLogUnread", { count: workLogThread.unreadCount ?? 0 })}</span>
                                </span>
                            )}
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
                    {/* Deleting is rare and destructive: a quiet overflow item, not a red header button. */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button type="button" variant="ghost" size="icon-sm" aria-label={tc("moreActions")} title={tc("moreActions")}>
                                <IconDots className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-44">
                            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                                <IconTrash />
                                {tDelete("button")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <DeleteAgentDialog agentId={agent.id} agentName={agent.name} trigger={null} open={deleteOpen} onOpenChange={setDeleteOpen}
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

            {/* Runtime and model configuration stays editable before the first connection, too. */}
            <section aria-labelledby="agent-config-heading" className="border-b border-zinc-800/80">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 sm:px-5">
                    <h3 id="agent-config-heading" className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
                        {t("configTitle")}
                    </h3>
                    <p className="text-[11px] text-zinc-500">{t("configHint")}</p>
                </div>

                <div className="grid grid-cols-1 gap-x-6 gap-y-5 px-4 pb-5 sm:grid-cols-2 sm:px-5 lg:grid-cols-3">
                    <ConfigField
                        label={fieldLabel(t("providerLabel"))}
                        editLabel={t("changeProvider")}
                        onEdit={() => setEditingProvider(true)}
                    >
                        {editingProvider ? (
                            <div>
                                <Select
                                    value={agent.provider || "mcp"}
                                    disabled={saving}
                                    onChange={(e) => {
                                        updateAgent({ provider: e.target.value });
                                        setEditingProvider(false);
                                    }}
                                    onOpenChange={(open) => { if (!open) setEditingProvider(false); }}
                                    className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-200 outline-none focus:border-cyan-400"
                                    autoFocus
                                    defaultOpen
                                >
                                    <option disabled={agent.deploymentMode === "local"} value="mcp">{t("genericMcp")}</option>
                                    {RUNTIME_OPTIONS.map((option) => (
                                        <option key={option.value} disabled={option.value !== "hermes" && agent.deploymentMode === "local"} value={option.value}>{option.label}</option>
                                    ))}
                                </Select>
                                <div className="mt-2 flex items-center gap-2 text-xs">
                                    <button type="button" onClick={() => setEditingProvider(false)} className="rounded px-1.5 py-0.5 text-zinc-500 hover:text-zinc-300">{tc("cancel")}</button>
                                </div>
                            </div>
                        ) : (
                            <span>{(provider && PROVIDER_EMOJI[provider.id]) ?? "🔌"} {provider?.name || t("genericMcpName")}</span>
                        )}
                    </ConfigField>

                    <ConfigField
                        label={fieldLabel(t("deploymentLabel"))}
                        editLabel={t("changeDeployment")}
                        onEdit={() => setEditingDeployment(true)}
                    >
                        {editingDeployment ? (
                            <div>
                                <Select
                                    value={agent.deploymentMode || "remote"}
                                    disabled={saving}
                                    onChange={(e) => {
                                        updateAgent({ deploymentMode: e.target.value });
                                        setEditingDeployment(false);
                                    }}
                                    onOpenChange={(open) => { if (!open) setEditingDeployment(false); }}
                                    className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-200 outline-none focus:border-cyan-400"
                                    autoFocus
                                    defaultOpen
                                >
                                    <option value="remote">{t("remote")}</option>
                                    <option disabled={agent.provider !== "hermes"} value="local">{t("localThisServer")}</option>
                                </Select>
                                <div className="mt-2 flex items-center gap-2 text-xs">
                                    <button type="button" onClick={() => setEditingDeployment(false)} className="rounded px-1.5 py-0.5 text-zinc-500 hover:text-zinc-300">{tc("cancel")}</button>
                                </div>
                            </div>
                        ) : (
                            <span>{agent.deploymentMode === "local" ? t("local") : t("remote")}</span>
                        )}
                    </ConfigField>

                    <ConfigField label={fieldLabel(t("lastSeen"))}>
                        {agent.lastSeenAt
                            ? <span>{format.dateTime(new Date(agent.lastSeenAt), { timeStyle: "medium" })}</span>
                            : <span className="text-zinc-500">{t("none")}</span>}
                    </ConfigField>

                    <ConfigField
                        label={fieldLabel(t("llmLabel"))}
                        editLabel={t("configureLlm")}
                        onEdit={canAdmin ? () => startLlmEdit() : undefined}
                        hint={!editingLlm && agent.llmProvider ? (
                            <a href="/docs/v1.1/troubleshooting#5-agent-setup--llm-configuration" target="_blank" className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2" title={t("setupGuideTitle")}>
                                {t("setupGuide")}
                            </a>
                        ) : undefined}
                    >
                        {editingLlm && canAdmin ? (
                            <div>
                                <Select
                                    value={llmDraft.provider}
                                    disabled={saving}
                                    aria-label={t("llmProvider")}
                                    onChange={(e) => {
                                        const nextProvider = e.target.value;
                                        setLlmDraft((draft) => ({ ...draft, provider: nextProvider, pendingModel: null }));
                                        setLlmError(null);
                                    }}
                                    className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-200 outline-none focus:border-cyan-400"
                                >
                                    <option value="">{t("none")}</option>
                                    {Object.entries(LLM_PROVIDER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                                    <option value={CUSTOM_LLM_PROVIDER}>{t("customEndpoint")}</option>
                                </Select>
                                <div className="mt-2 flex items-center gap-2 text-xs">
                                    <button
                                        type="button"
                                        disabled={saving}
                                        onClick={() => void saveLlm()}
                                        className="rounded px-1.5 py-0.5 font-medium text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
                                    >
                                        {tc("save")}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={closeLlmEdit}
                                        className="rounded px-1.5 py-0.5 text-zinc-500 hover:text-zinc-300"
                                    >
                                        {tc("cancel")}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <span>{agent.llmProvider ? llmLabel(agent.llmProvider) : t("none")}</span>
                        )}
                    </ConfigField>

                    <ConfigField
                        label={fieldLabel(t("modelLabel"))}
                        editLabel={t("model")}
                        onEdit={data.agent.llmProvider === CUSTOM_LLM_PROVIDER || !canAdmin ? undefined : () => setEditingModel(true)}
                    >
                        {/* A custom endpoint serves its own model names; the priced catalog would call them unavailable. */}
                        {data.agent.llmProvider === CUSTOM_LLM_PROVIDER || !canAdmin ? (
                            <span className={cn(!data.agent.llmModel && "text-zinc-500")}>{data.agent.llmModel || tModel("notSet")}</span>
                        ) : editingModel ? (
                            <div>
                                <ModelSearchSelect
                                    options={pricingOpts}
                                    value={data.agent.llmModel || ""}
                                    provider={data.agent.llmProvider || ""}
                                    disabled={saving}
                                    saving={saving}
                                    compact
                                    onChange={async (selection) => {
                                        // A model of another provider moves the agent to that provider's endpoint: ask for its key first.
                                        if (selection.provider && selection.provider !== (agent.llmProvider || "")) {
                                            setEditingModel(false);
                                            startLlmEdit(selection.provider, selection.model);
                                            return;
                                        }
                                        await updateAgent({
                                            llmProvider: selection.provider,
                                            llmModel: selection.model,
                                        });
                                        setEditingModel(false);
                                    }}
                                />
                                <div className="mt-2 flex items-center gap-2 text-xs">
                                    <button type="button" onClick={() => setEditingModel(false)} className="rounded px-1.5 py-0.5 text-zinc-500 hover:text-zinc-300">{tc("cancel")}</button>
                                </div>
                            </div>
                        ) : (
                            <span className={cn(!data.agent.llmModel && "text-zinc-500")}>{data.agent.llmModel || tModel("notSet")}</span>
                        )}
                    </ConfigField>

                    <ConfigField label={fieldLabel(tCreate("monthlyBudget"))}>
                        {(agent.monthlyBudgetCents ?? 0) > 0 ? (
                            <span className={cn(
                                "font-medium",
                                agent.budgetStatus === "paused" ? "text-rose-400" :
                                agent.budgetStatus === "warning" ? "text-amber-400" : "text-emerald-400"
                            )}>
                                {t("budget", { used: ((agent.monthlyTokenUsage ?? 0) / 1_000_000 * 1).toFixed(2), limit: ((agent.monthlyBudgetCents ?? 0) / 100).toFixed(0) }).replace(/^[^$]*/, "")}
                                {agent.budgetStatus === "paused" ? " ⏸️" : agent.budgetStatus === "warning" ? " ⚠️" : ""}
                            </span>
                        ) : (
                            <span className="text-zinc-500">{t("none")}</span>
                        )}
                    </ConfigField>
                </div>

                {editingLlm && canAdmin && (llmPlan.keyRequired || llmCustom || llmError) && (
                    <div className="px-4 pb-5 sm:px-5">
                        <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
                            <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-200">
                                {llmCustom ? t("customEndpoint") : t("llmProvider")}
                            </h4>
                            <div className="mt-2 space-y-2.5 text-xs">
                                {llmDraft.pendingModel && (
                                    <p className="text-muted-foreground">
                                        {t("pendingModel", { model: llmDraft.pendingModel, provider: llmDraftLabel })}
                                    </p>
                                )}
                                <div className="grid gap-3 sm:grid-cols-2">
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
                        </div>
                    </div>
                )}
            </section>

            {/* Setup banner — only for offline agents that need configuration (not those Emperor sets up on a host) */}
            {agent.status === "offline" && !data.provisioning && (
                <>
                    <div className="border-b border-zinc-800/80 px-4 py-4 sm:px-5">
                        <SetupBanner
                            agentId={agent.id}
                            agentName={agent.name}
                            agentRole={agent.role}
                            agentStatus={agent.status}
                            providerId={agent.provider || "mcp"}
                            deploymentMode={(agent.deploymentMode as "local" | "remote") || "remote"}
                        />
                    </div>
                    {!agent.lastSeenAt && (
                        runtimeSetup?.status === "failed" && !agent.containerId && agent.provider === "hermes" && agent.deploymentMode === "local" ? (
                            <div role="alert" className="border-b border-rose-500/15 bg-rose-500/[0.04] px-4 py-2 text-xs text-rose-200">
                                {t("setupFailed", { message: runtimeSetup.message })}
                            </div>
                        ) : withinStartupGrace ? (
                            <div className="border-b border-amber-500/15 bg-amber-500/[0.04] px-4 py-2 text-[11px] text-amber-200/80">
                                {t("startingUp")}
                            </div>
                        ) : (
                            <div className="border-b border-rose-500/15 bg-rose-500/[0.04] px-4 py-2 text-[11px] text-rose-300/70">
                                {t("neverConnected")}
                                {agent.provider === "hermes" ? ` ${t("seeGuideBelow")}` : ""}
                            </div>
                        )
                    )}
                </>
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
                    <AgentDirectChat agentId={agent.id} agentName={agent.name} showStopAll />
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

function ConfigField({ label, htmlFor, children, onEdit, editLabel, hint }: {
    label: string;
    htmlFor?: string;
    children: React.ReactNode;
    onEdit?: () => void;
    editLabel?: string;
    hint?: React.ReactNode;
}) {
    return (
        <div className="group min-w-0">
            <div className="flex items-center justify-between gap-2">
                <label htmlFor={htmlFor} className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</label>
                {onEdit && (
                    <button type="button" onClick={onEdit} aria-label={editLabel}
                        className="shrink-0 rounded p-1 text-zinc-600 transition-colors hover:text-zinc-300 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60">
                        <IconPencil className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>
            <div className="mt-1 min-h-6 text-sm font-medium text-zinc-200">{children}</div>
            {hint ? <p className="mt-1 text-[11px] leading-snug text-zinc-500">{hint}</p> : null}
        </div>
    );
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
    const tcCommon = useTranslations("common");
    const [copiedToken, setCopiedToken] = useState(false);
    const [copiedCmd, setCopiedCmd] = useState(false);
    const [copiedCmdIndex, setCopiedCmdIndex] = useState<number | null>(null);
    const [endpointCopied, setEndpointCopied] = useState(false);
    const [copiedPrompt, setCopiedPrompt] = useState(false);
    const [copiedEnv, setCopiedEnv] = useState(false);
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
    const commands = providerId === "hermes" ? [installerDownloadCommand(), ...provider.installCommands] : provider.installCommands;
    const baseUrl = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
    const mcpEndpoint = `${baseUrl}/api/mcp`;

    const bridgeEnv = () => {
        return [
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
    };
    const copyToken = async () => {
        if (!genToken) return;
        await navigator.clipboard.writeText(genToken);
        setCopiedToken(true);
        setTimeout(() => setCopiedToken(false), 2000);
    };
    const copyCommand = async (command: string, index: number) => {
        await navigator.clipboard.writeText(command);
        setCopiedCmdIndex(index);
        setTimeout(() => setCopiedCmdIndex(null), 2000);
    };
    const copyEndpoint = async () => {
        await navigator.clipboard.writeText(mcpEndpoint);
        setEndpointCopied(true);
        setTimeout(() => setEndpointCopied(false), 2000);
    };
    const copyPrompt = async () => {
        await navigator.clipboard.writeText(setupPrompt);
        setCopiedPrompt(true);
        setTimeout(() => setCopiedPrompt(false), 2000);
    };
    const copyEnv = async () => {
        await navigator.clipboard.writeText(bridgeEnv());
        setCopiedEnv(true);
        setTimeout(() => setCopiedEnv(false), 2000);
    };

    if (providerId === "hermes" && isLocal) return (
        <div className="overflow-hidden rounded-2xl border border-zinc-800 border-t-emerald-500/40 bg-zinc-950/40">
            <div className="border-b border-zinc-800 bg-zinc-900/40 px-4 py-3">
                <h3 className="text-sm font-semibold text-zinc-100">{t("startLocal")}</h3>
                <p className="mt-0.5 text-[11px] text-zinc-500">{t("startLocalHint")}</p>
            </div>
            <div className="space-y-3 p-4">
                <button type="button" disabled={setupRunning} onClick={async () => {
                    setSetupRunning(true); setSetupResult(null);
                    try {
                        const response = await fetch(`/api/agents/${agentId}/recreate-runtime`, { method: "POST" });
                        const data = await response.json();
                        setSetupResult(response.ok ? data : { success: false, message: data.error || t("setupFailed") });
                        if (response.ok && data.success) setTimeout(() => window.location.reload(), 2000);
                    } catch (e) { setSetupResult({ success: false, message: e instanceof Error ? e.message : t("setupFailed") }); }
                    finally { setSetupRunning(false); }
                }} className="min-h-8 rounded-lg bg-emerald-500 px-2.5 text-[11px] font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 disabled:opacity-50">
                    {setupRunning ? t("startingHermes") : t("retryLocal")}
                </button>
                {setupResult && <div className="space-y-2 text-xs" role="status">
                    <p className={setupResult.success ? "text-emerald-300" : "text-rose-300"}>{setupResult.message}</p>
                    {setupResult.outputs && <SetupOutputLog outputs={setupResult.outputs} />}
                </div>}
            </div>
        </div>
    );

    return (
        <div className={cn(
            "overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/40",
            isLocal ? "border-t-emerald-500/40" : "border-t-amber-500/40",
        )}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/40 px-4 py-3">
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-zinc-100">{t("whatToDo")}</h3>
                    <p className="mt-0.5 text-[11px] text-zinc-500">
                        {isOnline
                            ? t("onlineProcessing", { name: agentName, provider: provider.name })
                            : isLocal
                                ? t("configuredLocal", { name: agentName, role: agentRole, provider: provider.name })
                                : t("configuredRemote", { name: agentName, role: agentRole, provider: provider.name })
                        }
                    </p>
                </div>
                <span className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                    setupResult && !setupResult.success
                        ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
                        : setupRunning
                            ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                            : isLocal
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                : "border-amber-500/30 bg-amber-500/10 text-amber-200",
                )}>
                    {setupResult && !setupResult.success ? t("setupFailed") : setupRunning ? t("settingUpHermes") : t("notConnectedChip")}
                </span>
            </div>

            <ol className="divide-y divide-zinc-800/70">
                <li className="flex gap-3 px-4 py-4">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-[11px] font-semibold text-zinc-300">
                        1
                    </span>
                    <div className="min-w-0 flex-1 space-y-2">
                        <h4 className="text-xs font-semibold text-zinc-200">{t("stepCredential")}</h4>
                        <p className="text-[11px] text-zinc-500">{t("stepCredentialHint")}</p>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            {!genToken && (
                                <button
                                    type="button"
                                    onClick={generateToken}
                                    disabled={genningToken}
                                    className="min-h-8 rounded-lg bg-emerald-500 px-2.5 text-[11px] font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
                                >
                                    {genningToken ? t("generating") : t("generateToken")}
                                </button>
                            )}
                            <Link href="/settings?tab=access-tokens" className="text-[11px] text-zinc-400 underline underline-offset-2 hover:text-zinc-200">
                                {t("openAccessTokens")}
                            </Link>
                        </div>
                        {genToken && (
                            <div className="flex min-w-0 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-2">
                                <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-200">{genToken}</code>
                                <button
                                    type="button"
                                    onClick={() => void copyToken()}
                                    className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg border border-zinc-700 px-2.5 text-[11px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
                                >
                                    {copiedToken ? <IconCircleCheck className="h-3 w-3 text-emerald-400" /> : <IconCopy className="h-3 w-3" />}
                                    {copiedToken ? t("copied") : tcCommon("copy")}
                                </button>
                            </div>
                        )}
                        {genTokenError && <p className="text-[11px] text-rose-300">{t("tokenError", { error: genTokenError })}</p>}
                    </div>
                </li>

                <li className="flex gap-3 px-4 py-4">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-[11px] font-semibold text-zinc-300">
                        2
                    </span>
                    <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h4 className="text-xs font-semibold text-zinc-200">{t("stepConnect")}</h4>
                            {commands.length > 0 && (
                                <button
                                    type="button"
                                    onClick={async () => {
                                        await navigator.clipboard.writeText(commands.map(applyVars).join("\n"));
                                        setCopiedCmd(true);
                                        setTimeout(() => setCopiedCmd(false), 2000);
                                    }}
                                    className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-zinc-700 px-2.5 text-[11px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
                                >
                                    {copiedCmd ? <IconCircleCheck className="h-3 w-3 text-emerald-400" /> : <IconCopy className="h-3 w-3" />}
                                    {copiedCmd ? t("copied") : t("copyAll")}
                                </button>
                            )}
                        </div>
                        {providerId === "hermes" && <p className="text-[11px] text-zinc-500">{t("stepDownload")}</p>}
                        {commands.length > 0 ? (
                            <div className="space-y-2">
                                {commands.map((cmd, i) => {
                                    const command = applyVars(cmd);
                                    return (
                                        <div key={i} className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                                            <code className="min-w-0 flex-1 font-mono text-[11px] break-all text-zinc-300">{command}</code>
                                            <button
                                                type="button"
                                                onClick={() => void copyCommand(command, i)}
                                                className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg border border-zinc-700 px-2.5 text-[11px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
                                            >
                                                {copiedCmdIndex === i ? <IconCircleCheck className="h-3 w-3 text-emerald-400" /> : <IconCopy className="h-3 w-3" />}
                                                {copiedCmdIndex === i ? t("copied") : tcCommon("copy")}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="space-y-1.5">
                                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">{t("mcpEndpoint")}</span>
                                <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                                    <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-zinc-300">{mcpEndpoint}</code>
                                    <button type="button" onClick={copyEndpoint}
                                        className="flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 text-[11px] font-medium text-zinc-300 hover:bg-zinc-800">
                                        {endpointCopied ? <IconCircleCheck className="h-3.5 w-3.5" /> : <IconCopy className="h-3.5 w-3.5" />}
                                        {endpointCopied ? t("copied") : tcCommon("copy")}
                                    </button>
                                </div>
                            </div>
                        )}
                        {genToken ? (
                            <p className="text-[11px] text-zinc-500">{t("tokenInserted")}</p>
                        ) : genTokenError ? (
                            <p className="text-[11px] text-rose-300">{t("tokenError", { error: genTokenError })}</p>
                        ) : (
                            <p className="text-[11px] text-zinc-500">
                                {t.rich("tokenHint", { placeholder: "YOUR_TOKEN", strong: (chunks) => <span className="text-zinc-300">{chunks}</span>, code: (chunks) => <code className="text-zinc-300">{chunks}</code> })}
                            </p>
                        )}
                        <p className="text-[11px] text-zinc-500">
                            {isLocal
                                ? t("assumesLocal", { provider: provider.name })
                                : t("assumesRemote", { provider: provider.name })
                            }
                        </p>
                        {providerId === "hermes" && (
                            <div className="space-y-1.5 text-[11px] text-zinc-500">
                                <p className="break-words">
                                    {t.rich("stepProfile", { command: `hermes profile create ${hermesProfileName(agentName)} --clone`, file: ".env", code: (chunks) => <code className="text-zinc-300">{chunks}</code>, file1: (chunks) => <code className="text-zinc-300">{chunks}</code> })}
                                </p>
                                <p className="break-words">
                                    {t.rich("stepInstall", { command: `~/.local/bin/emperor-hermes install --profile ${hermesProfileName(agentName)}`, code: (chunks) => <code className="text-zinc-300">{chunks}</code> })}
                                </p>
                                <p>{t("stepConnectHost")}</p>
                                <p>
                                    {t.rich("migration", {
                                        guide: (chunks) => <a href={HERMES_MIGRATION_DOC_HREF} target="_blank" rel="noreferrer" className="text-cyan-400 underline underline-offset-2 hover:text-cyan-300">{chunks}</a>,
                                        full: (chunks) => <a href="/docs/v1.1/hermes-runtime" target="_blank" rel="noreferrer" className="text-cyan-400 underline underline-offset-2 hover:text-cyan-300">{chunks}</a>,
                                        online: (chunks) => <span className="text-emerald-300">{chunks}</span>,
                                    })}
                                </p>
                            </div>
                        )}
                    </div>
                </li>

                <li className="flex gap-3 px-4 py-4">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-[11px] font-semibold text-zinc-300">
                        3
                    </span>
                    <div className="min-w-0 flex-1 space-y-2">
                        <h4 className="text-xs font-semibold text-zinc-200">{t("stepConfigure")}</h4>
                        <details className="rounded-lg border border-zinc-800 bg-zinc-950/60">
                            <summary className="cursor-pointer px-3 py-2 text-xs text-zinc-300">
                                {isLocal ? t("promptOptional") : t("prompt")}
                            </summary>
                            <div className="space-y-4 border-t border-zinc-800 p-3">
                                {providerId === "hermes" && (
                                    <div className="space-y-2">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">{t("bridgeConfig")}</span>
                                            <button
                                                type="button"
                                                onClick={() => void copyEnv()}
                                                className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-zinc-700 px-2.5 text-[11px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
                                            >
                                                {copiedEnv ? <IconCircleCheck className="h-3 w-3 text-emerald-400" /> : <IconCopy className="h-3 w-3" />}
                                                {copiedEnv ? t("copied") : t("copyEnv")}
                                            </button>
                                        </div>
                                        <p className="text-[11px] text-zinc-500">
                                            {t.rich("saveEnv", { path: `~/.hermes/emperor-bridge/${agentName}/.env`, code: (chunks) => <code className="text-zinc-300">{chunks}</code>, strong: (chunks) => <strong>{chunks}</strong> })}
                                        </p>
                                        <pre className="max-h-[220px] overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] text-zinc-300">
                                            {bridgeEnv()}
                                        </pre>
                                    </div>
                                )}
                                <div className="space-y-2">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">{isLocal ? t("promptOptional") : t("prompt")}</span>
                                        <button
                                            type="button"
                                            onClick={() => void copyPrompt()}
                                            className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-zinc-700 px-2.5 text-[11px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
                                        >
                                            {copiedPrompt ? <IconCircleCheck className="h-3 w-3 text-emerald-400" /> : <IconCopy className="h-3 w-3" />}
                                            {copiedPrompt ? t("copied") : t("copyPrompt")}
                                        </button>
                                    </div>
                                    <pre className="max-h-[220px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] text-zinc-300 select-all">
                                        {setupPrompt}
                                    </pre>
                                </div>
                            </div>
                        </details>
                    </div>
                </li>

                <li className="flex gap-3 px-4 py-4">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-[11px] font-semibold text-zinc-300">
                        4
                    </span>
                    <div className="min-w-0 flex-1 space-y-2">
                        <h4 className="text-xs font-semibold text-zinc-200">{t("stepVerify")}</h4>
                        <div className="space-y-1.5">
                            {provider.postInstallChecklist.filter((step) => !/dashboard/i.test(step)).map((step, i) => (
                                <div key={i} className="flex items-start gap-2 text-[12px] text-zinc-400">
                                    <span className="shrink-0 text-zinc-500">{i + 1}.</span>
                                    <span>{applyVars(step)}</span>
                                </div>
                            ))}
                            <div className="flex items-start gap-2 text-[12px] text-zinc-400">
                                <span className="shrink-0 text-emerald-400">✓</span>
                                <span>{t.rich("checkDashboard", { name: agentName, strong: (chunks) => <strong>{chunks}</strong> })}</span>
                            </div>
                        </div>
                    </div>
                </li>
            </ol>
        </div>
    );
}
