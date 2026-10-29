"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RoleTemplatePicker } from "./role-template-picker";
import { getAgentTemplate, type AgentRoleTemplate } from "@/lib/agent-templates";
import { getAvailableProviders, getProvider, type AgentProvider } from "@/lib/agent-providers";
import { ModelSearchSelect } from "@/components/model-search-select";
import { CharacterAvatar } from "@/components/character/character-avatar";
import { cn } from "@/lib/utils";
import { DEFAULT_HOST_MODEL } from "@/lib/runtime-hosts/commands";
import { EVERYONE_ACCESS, WhoCanUseField, hireAccessBody, useAccessPeople, type AgentAccessValue } from "@/components/access/agent-access-control";
import { HireProgress, HostPicker, useHireHosts, type HostChoice } from "@/components/runtime-hosts/host-picker";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

type Step = "role" | "provider" | "name" | "progress";

const providers = getAvailableProviders();

type PricingOption = { provider: string; model: string; label: string; inputPricePer1k: number; outputPricePer1k: number };

/** Product names, not copy. */
const LLM_PROVIDER_OPTIONS = [
    { value: "openai", label: "OpenAI" },
    { value: "anthropic", label: "Anthropic" },
    { value: "google", label: "Google Gemini" },
    { value: "openrouter", label: "OpenRouter" },
    { value: "grok", label: "Grok" },
    { value: "deepseek", label: "DeepSeek" },
];
const DOCTRINE_FILES = "SOUL.md, AGENTS.md, BOOTSTRAP.md, IDENTITY.md";
const PROVIDER_EMOJI: Record<string, string> = { openclaw: "🦀", hermes: "👑", codex: "🧠" };

export function CreateAgentDialog({
    onAgentCreated,
    open: controlledOpen,
    onOpenChange,
    triggerVariant = "default",
    hideTrigger = false,
}: {
    onAgentCreated?: (agentId: string) => void;
    /**
     * Optional controlled-mode props. Omit both for the original self-contained
     * (uncontrolled) usage — the dialog manages its own open state via its
     * built-in trigger button, exactly as before. Passed by `agents-client.tsx`
     * so `EasySetupDialog`'s "Advanced" option can open this dialog
     * programmatically without duplicating any of its logic.
     */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Visual demotion when Easy Setup is the primary action — no behavior change. */
    triggerVariant?: "default" | "outline";
    /**
     * Suppress the built-in "Hire Agent" trigger button entirely — used when
     * EasySetupDialog is the sole entry point (its own "Advanced" option opens
     * this dialog programmatically via `open`). Avoids showing two buttons
     * that both lead to the same Advanced flow.
     */
    hideTrigger?: boolean;
}) {
    const t = useTranslations("agents.create");
    const tc = useTranslations("common");
    const router = useRouter();
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const isControlled = controlledOpen !== undefined;
    const open = isControlled ? controlledOpen : uncontrolledOpen;
    const setOpen = (o: boolean) => {
        if (!isControlled) setUncontrolledOpen(o);
        onOpenChange?.(o);
    };
    const [step, setStep] = useState<Step>("role");
    const [selectedRole, setSelectedRole] = useState<AgentRoleTemplate | null>(null);
    const [selectedProvider, setSelectedProvider] = useState<AgentProvider>(providers[0]);
    const [name, setName] = useState("");
    const [deploymentMode, setDeploymentMode] = useState<"remote" | "local">("remote");
    const [monthlyBudget, setMonthlyBudget] = useState(""); // dollars, empty = unlimited
    const [llmProvider, setLlmProvider] = useState("");
    const [llmModel, setLlmModel] = useState("");
    const [pricingOptions, setPricingOptions] = useState<PricingOption[]>([]);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [whoCanUse, setWhoCanUse] = useState<AgentAccessValue>(EVERYONE_ACCESS);
    const accessPeople = useAccessPeople(step === "name");
    // "Another machine" with a connected runtime host (0.22): Emperor sets the agent up there.
    const wantsHosts = open && step === "name" && selectedProvider.id === "hermes" && deploymentMode === "remote";
    const { hosts, forbidden: hostsForbidden } = useHireHosts(wantsHosts);
    const [hostChoice, setHostChoice] = useState<HostChoice | null>(null);
    const [hostTouched, setHostTouched] = useState(false);
    const [hireProgress, setHireProgress] = useState<{ jobId: string; agentId: string; agentName: string; hostName: string } | null>(null);
    const onHost = wantsHosts && hostChoice !== null;
    const chosenHost = onHost ? hosts?.find((h) => h.id === hostChoice?.hostId) ?? null : null;

    // The first host that can take the agent is preselected (once; "I'll set it up myself" stays one click away).
    useEffect(() => {
        if (!hosts || hostTouched || hostChoice) return;
        const ready = hosts.find((h) => h.hire.ok && h.hire.providers.length > 0);
        if (ready) setHostChoice({ hostId: ready.id, llmProvider: ready.hire.providers[0], model: DEFAULT_HOST_MODEL[ready.hire.providers[0]] });
    }, [hosts, hostTouched, hostChoice]);

    useEffect(() => {
        if (open) {
            fetch("/api/ui/pricing").then(r => r.json()).then(d => {
                setPricingOptions(d.pricing || []);
            }).catch(() => {});
        }
    }, [open]);

    const handleRoleSelect = (roleId: string) => {
        const template = getAgentTemplate(roleId);
        if (template) {
            setSelectedRole(template);
            setName(template.title);
            const bestProvider = template.runtime !== "any"
                ? providers.find((p) => p.id === template.runtime) || providers[0]
                : providers[0];
            setSelectedProvider(bestProvider);
            if (!bestProvider.supportsLocal) setDeploymentMode("remote");
            setStep("provider");
        } else {
            setSelectedRole(null);
            setStep("provider");
        }
    };

    const handleProviderSelect = (providerId: string) => {
        const provider = getProvider(providerId);
        if (provider) {
            setSelectedProvider(provider);
            if (!provider.supportsLocal) setDeploymentMode("remote");
            setStep("name");
        }
    };

    const handleCreate = async () => {
        setIsSaving(true);
        setError(null);
        try {
            const doctrine: Record<string, string> = {};
            if (selectedRole) {
                doctrine["SOUL.md"] = selectedRole.soul;
                doctrine["AGENTS.md"] = selectedRole.agents;
                doctrine["BOOTSTRAP.md"] = selectedRole.bootstrap;
                doctrine["IDENTITY.md"] = selectedRole.identity;
            }

            const agentName = name.trim() || (selectedRole?.title || "Agent");
            const res = await fetch("/api/agents", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: agentName,
                    role: selectedRole?.title || name.trim() || "Custom",
                    provider: selectedProvider.id,
                    deploymentMode,
                    monthlyBudgetCents: monthlyBudget ? Math.round(parseFloat(monthlyBudget) * 100) : 0,
                    ...(onHost && hostChoice
                        ? { runtimeHostId: hostChoice.hostId, llmProvider: hostChoice.llmProvider, model: hostChoice.model.trim() || undefined }
                        : { llmProvider: llmProvider || undefined, llmModel: llmModel || undefined }),
                    doctrineJson: doctrine,
                    ...hireAccessBody(whoCanUse),
                }),
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || t("failed"));
            router.refresh();
            if (typeof data.jobId === "string") {
                // Set up on a host: stay open and show the setup live.
                setHireProgress({ jobId: data.jobId, agentId: data.agent.id, agentName, hostName: data.runtimeHost?.name ?? chosenHost?.name ?? t("theHost") });
                setStep("progress");
                return;
            }
            if (typeof data.hostError === "string") {
                toast.error(t("hostQueueFailed", { name: agentName }), { description: t("hostQueueFailedHint", { error: data.hostError }) });
            }
            setOpen(false);
            resetForm();
            onAgentCreated?.(data.agent.id);
        } catch (e) {
            setError(e instanceof Error ? e.message : t("failed"));
        } finally {
            setIsSaving(false);
        }
    };

    const resetForm = () => {
        setStep("role");
        setSelectedRole(null);
        setSelectedProvider(providers[0]);
        setName("");
        setDeploymentMode("remote");
        setMonthlyBudget("");
        setLlmProvider("");
        setLlmModel("");
        setWhoCanUse(EVERYONE_ACCESS);
        setHostChoice(null);
        setHostTouched(false);
        setHireProgress(null);
        setError(null);
    };

    const avatarSeed = name.trim() || selectedRole?.title || "agent";

    const closeAfterProgress = () => {
        const agentId = hireProgress?.agentId;
        setOpen(false);
        resetForm();
        if (agentId) onAgentCreated?.(agentId);
    };

    return (
        <Dialog open={open} onOpenChange={(o) => {
            if (!o && step === "progress") { closeAfterProgress(); return; }
            setOpen(o);
            if (!o) resetForm();
        }}>
            {!hideTrigger && (
                <DialogTrigger asChild>
                    <Button variant={triggerVariant} className="shadow-sm">{t("hire")}</Button>
                </DialogTrigger>
            )}
            <DialogContent className="sm:max-w-[580px] max-h-[90dvh] flex flex-col overflow-hidden bg-zinc-950 border-zinc-800 text-zinc-200">
                <DialogHeader>
                    <DialogTitle className="text-zinc-100">
                        {step === "role" && t("steps.role")}
                        {step === "provider" && t("steps.provider")}
                        {step === "name" && t("steps.name")}
                        {step === "progress" && t("steps.progress", { name: hireProgress?.agentName ?? t("theAgent") })}
                    </DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        {step === "role" && t("steps.roleHint")}
                        {step === "provider" && t("steps.providerHint")}
                        {step === "name" && t("steps.nameHint")}
                        {step === "progress" && t("steps.progressHint")}
                    </DialogDescription>
                </DialogHeader>

                {/* The body scrolls; the footer (Cancel / Hire) always stays in view. */}
                <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-1">

                {/* Step 1: Role Selection */}
                {step === "role" && (
                    <RoleTemplatePicker
                        selectedId={selectedRole?.id ?? null}
                        allowCustom
                        onSelect={(roleId) => {
                            if (roleId) {
                                handleRoleSelect(roleId);
                            } else {
                                setSelectedRole(null);
                                setName("");
                                setStep("provider");
                            }
                        }}
                    />
                )}

                {/* Step 2: Provider Selection */}
                {step === "provider" && (
                    <div className="space-y-2 py-2 max-h-[340px] overflow-y-auto">
                        {selectedRole && (
                            <div className="flex items-center gap-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 mb-3">
                                <span className="text-lg" aria-hidden="true">{selectedRole.emoji}</span>
                                <div>
                                    <span className="text-sm font-medium text-cyan-100">{selectedRole.title}</span>
                                    <span className="block text-[11px] text-cyan-100/60">
                                        {selectedRole.runtime === "any" ? t("anyRuntime") : t("bestWith", { runtime: selectedRole.runtime })}
                                    </span>
                                </div>
                            </div>
                        )}
                        {/* Hermes prerequisite warning */}
                        {selectedProvider.id === "hermes" && (
                        <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 mb-2">
                            <span className="text-[10px] font-bold text-amber-300 uppercase tracking-wider">{t("beforeYouContinue")}</span>
                            <p className="text-[10px] text-amber-200/70 mt-0.5 leading-relaxed">
                                {t("hermesPrereq")}
                            </p>
                        </div>
                        )}
                        {/* Key guidance for the selected provider */}
                        {selectedProvider.supportsLlmProvider && (
                        <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 mb-2">
                            <span className="text-[10px] font-bold text-amber-300 uppercase tracking-wider">{t("apiKeys")}</span>
                            <p className="text-[10px] text-amber-200/70 mt-0.5 leading-relaxed">
                                {t("apiKeysHint")}
                            </p>
                        </div>
                        )}
                        {providers.map((provider) => (
                            <button
                                key={provider.id}
                                type="button"
                                onClick={() => handleProviderSelect(provider.id)}
                                className={cn(
                                    "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                                    selectedProvider.id === provider.id
                                        ? "border-cyan-400/40 bg-cyan-400/10"
                                        : "border-zinc-800 bg-zinc-900/70 hover:border-zinc-600 hover:bg-zinc-900"
                                )}
                            >
                                <span className="text-xl shrink-0 mt-0.5" aria-hidden="true">
                                    {PROVIDER_EMOJI[provider.id] ?? "🔌"}
                                </span>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium text-zinc-100">{provider.name}</span>
                                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 uppercase">
                                            {provider.executionModel === "persistent" ? t("daemon") : t("onDemand")}
                                        </span>
                                    </div>
                                    <span className="block text-[11px] leading-tight text-zinc-400 mt-0.5">{provider.description}</span>
                                </div>
                            </button>
                        ))}
                    </div>
                )}

                {/* Step 3: Name & Create */}
                {step === "name" && (
                    <div className="space-y-4 py-2">
                        <div className="flex items-center gap-4">
                            <div className="w-14 h-14 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center overflow-hidden shrink-0">
                                <CharacterAvatar agentId={avatarSeed} name={t("preview")} size={56} decorative />
                            </div>
                            <div className="flex-1 space-y-1">
                                <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">{t("agentName")}</label>
                                <input
                                    className="w-full bg-zinc-900 border-zinc-800 focus:ring-1 focus:ring-cyan-500 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none"
                                    placeholder={t("agentNamePlaceholder")}
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    autoFocus
                                />
                            </div>
                        </div>

                        <div className="space-y-3">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">{t("whereRun")}</label>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    onClick={() => setDeploymentMode("remote")}
                                    className={cn(
                                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                                        deploymentMode === "remote"
                                            ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100"
                                            : "border-zinc-800 bg-zinc-900/70 text-zinc-400 hover:border-zinc-600"
                                    )}
                                >
                                    <span className="text-sm" aria-hidden="true">{"🌐"}</span>
                                    <div>
                                        <span className="block font-medium">{t("anotherMachine")}</span>
                                        <span className="text-[10px] opacity-70">{t("anotherMachineHint")}</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setDeploymentMode("local")}
                                    disabled={!selectedProvider.supportsLocal}
                                    title={selectedProvider.supportsLocal ? undefined : t("noLocal", { provider: selectedProvider.name })}
                                    className={cn(
                                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                                        !selectedProvider.supportsLocal
                                            ? "border-zinc-800/50 bg-zinc-900/30 text-zinc-500 cursor-not-allowed"
                                            : deploymentMode === "local"
                                                ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-100"
                                                : "border-zinc-800 bg-zinc-900/70 text-zinc-400 hover:border-zinc-600"
                                    )}
                                >
                                    <span className="text-sm" aria-hidden="true">{"🖥️"}</span>
                                    <div>
                                        <span className="block font-medium">{t("thisServer")}</span>
                                        <span className="text-[10px] opacity-70">{t("thisServerHint")}</span>
                                    </div>
                                </button>
                            </div>
                            {wantsHosts && (
                                <HostPicker hosts={hosts} forbidden={hostsForbidden} value={hostChoice}
                                    onChange={(choice) => { setHostTouched(true); setHostChoice(choice); }} />
                            )}
                        </div>

                        {/* Monthly budget */}
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">{t("monthlyBudget")}</label>
                            <div className="flex items-center gap-2">
                                <span className="text-zinc-400 text-sm">{"$"}</span>
                                <input
                                    type="number"
                                    min="0"
                                    step="1"
                                    className="w-24 bg-zinc-900 border-zinc-800 focus:ring-1 focus:ring-cyan-500 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none"
                                    placeholder="∞"
                                    value={monthlyBudget}
                                    onChange={(e) => setMonthlyBudget(e.target.value)}
                                />
                                <span className="text-[10px] text-zinc-400">{t("unlimitedHint")}</span>
                            </div>
                        </div>

                        <WhoCanUseField value={whoCanUse} onChange={setWhoCanUse} people={accessPeople.people} me={accessPeople.me} />

                        {/* LLM Provider — only for runtimes that read it (Hermes); a host hire picks it above */}
                        {selectedProvider.supportsLlmProvider && !onHost && (
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                                {t("llmProvider")} <span className="text-zinc-500 font-normal">{t("optionalMetadata")}</span>
                            </label>
                            <p className="text-[10px] text-zinc-400 -mt-0.5">
                                {t("llmProviderHint")}
                            </p>
                            <select
                                value={llmProvider}
                                onChange={(event) => {
                                    const nextProvider = event.target.value;
                                    setLlmProvider(nextProvider);
                                    const selectedModel = pricingOptions.find((option) => option.model === llmModel);
                                    if (selectedModel && selectedModel.provider !== nextProvider) setLlmModel("");
                                }}
                                className="h-8 rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-200 outline-none focus:border-cyan-400 mt-1"
                            >
                                <option value="">{t("none")}</option>
                                {LLM_PROVIDER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>
                        </div>
                        )}

                        {/* LLM Model — searchable dropdown with pricing */}
                        {selectedProvider.supportsLlmProvider && !onHost && pricingOptions.length > 0 && (
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                                {t("llmModel")} <span className="text-zinc-500 font-normal">{t("forCostTracking")}</span>
                            </label>
                            <ModelSearchSelect
                                options={pricingOptions}
                                value={llmModel}
                                provider={llmProvider}
                                onChange={(selection) => {
                                    setLlmProvider(selection.provider);
                                    setLlmModel(selection.model);
                                }}
                            />
                        </div>
                        )}

                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3 space-y-2">
                            <span className="text-[10px] font-bold text-emerald-300 uppercase tracking-wider">{t("configuration")}</span>
                            <div className="grid gap-1.5 text-[11px]">
                                <div className="flex justify-between">
                                    <span className="text-zinc-400">{t("summary.role")}</span>
                                    <span className="text-zinc-300">{selectedRole ? `${selectedRole.emoji} ${selectedRole.title}` : t("summary.custom")}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-400">{t("summary.provider")}</span>
                                    <span className="text-zinc-300">{selectedProvider.name}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-400">{t("summary.deployment")}</span>
                                    <span className="text-zinc-300">{deploymentMode === "local" ? t("summary.thisServer") : chosenHost ? t("summary.onHost", { host: chosenHost.name }) : t("summary.remote")}</span>
                                </div>
                                {selectedRole && (
                                    <div className="flex justify-between">
                                        <span className="text-zinc-400">{t("summary.doctrine")}</span>
                                        <span className="text-emerald-300">{DOCTRINE_FILES}</span>
                                    </div>
                                )}
                                <div className="flex justify-between">
                                    <span className="text-zinc-400">{t("summary.budget")}</span>
                                    <span className="text-zinc-300">{monthlyBudget ? t("summary.perMonth", { amount: monthlyBudget }) : t("summary.unlimited")}</span>
                                </div>
                                {(onHost ? hostChoice?.llmProvider : llmProvider) && (
                                    <div className="flex justify-between">
                                        <span className="text-zinc-400">{t("summary.llm")}</span>
                                        <span className="text-emerald-300">{onHost ? `${hostChoice?.llmProvider} · ${hostChoice?.model.trim() || t("summary.defaultModel")}` : llmProvider}</span>
                                    </div>
                                )}
                            </div>
                        </div>

                        {error && (
                            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div>
                        )}

                        {/* What's next hint */}
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
                            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">{t("afterCreation")}</span>
                            <p className="text-[10px] text-zinc-400 mt-0.5 leading-relaxed">
                                {onHost
                                    ? t("afterHost", { host: chosenHost?.name ?? t("theHost") })
                                    : selectedProvider.id === "hermes"
                                    ? t("afterHermes")
                                    : t("afterOther")}
                            </p>
                            <p className="text-[10px] text-zinc-400 mt-1">
                                <a href="/docs/v1.1/troubleshooting#5-agent-setup--llm-configuration" target="_blank" className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2">
                                    {t("troubleshooting")}
                                </a>
                            </p>
                        </div>
                    </div>
                )}

                {step === "progress" && hireProgress && (
                    <HireProgress jobId={hireProgress.jobId} agentId={hireProgress.agentId} agentName={hireProgress.agentName} hostName={hireProgress.hostName} />
                )}
                </div>

                <DialogFooter className="shrink-0 border-t border-zinc-800 pt-3 flex items-center gap-2">
                    {step === "progress" && (
                        <Button type="button" onClick={closeAfterProgress} className="ml-auto bg-cyan-600 hover:bg-cyan-500 text-white">{tc("close")}</Button>
                    )}
                    {step !== "role" && step !== "progress" && (
                        <Button type="button" variant="outline" onClick={() => setStep(step === "provider" ? "role" : "provider")}
                            className="border-zinc-800 text-zinc-300 hover:bg-zinc-800">
                            {tc("back")}
                        </Button>
                    )}
                    {step !== "progress" && <div className="flex-1" />}
                    {step !== "progress" && (
                        <Button type="button" variant="outline" onClick={() => setOpen(false)} className="border-zinc-800 text-zinc-300 hover:bg-zinc-800">
                            {tc("cancel")}
                        </Button>
                    )}
                    {step === "name" && (
                        <Button type="button" onClick={handleCreate} disabled={isSaving || !name.trim() || (onHost && !chosenHost)} className="bg-cyan-600 hover:bg-cyan-500 text-white">
                            {isSaving ? t("creating") : onHost ? t("hireAndSetUp") : t("hire")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
