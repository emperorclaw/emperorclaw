"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { agentRoleTemplates, getAgentTemplate, type AgentRoleTemplate } from "@/lib/agent-templates";
import { getAvailableProviders, getProvider, type AgentProvider } from "@/lib/agent-providers";
import { cn } from "@/lib/utils";

type Step = "role" | "provider" | "name";

const providers = getAvailableProviders();

export function CreateAgentDialog({ onAgentCreated }: { onAgentCreated?: (agentId: string) => void }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState<Step>("role");
    const [selectedRole, setSelectedRole] = useState<AgentRoleTemplate | null>(null);
    const [selectedProvider, setSelectedProvider] = useState<AgentProvider>(providers[0]);
    const [name, setName] = useState("");
    const [deploymentMode, setDeploymentMode] = useState<"remote" | "local">("remote");
    const [monthlyBudget, setMonthlyBudget] = useState(""); // dollars, empty = unlimited
    const [llmProvider, setLlmProvider] = useState("");
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleRoleSelect = (roleId: string) => {
        const template = getAgentTemplate(roleId);
        if (template) {
            setSelectedRole(template);
            setName(template.title);
            const bestProvider = template.runtime !== "any"
                ? providers.find((p) => p.id === template.runtime) || providers[0]
                : providers[0];
            setSelectedProvider(bestProvider);
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

            const res = await fetch("/api/agents", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: name.trim() || (selectedRole?.title || "Agent"),
                    role: selectedRole?.title || name.trim() || "Custom",
                    provider: selectedProvider.id,
                    deploymentMode,
                    monthlyBudgetCents: monthlyBudget ? Math.round(parseFloat(monthlyBudget) * 100) : 0,
                    llmProvider: llmProvider || undefined,
                    doctrineJson: doctrine,
                    avatarUrl: `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(name.trim() || selectedRole?.title || "agent")}`,
                }),
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Agent creation failed");
            if (res.ok) {
                setOpen(false);
                resetForm();
                router.refresh();
                onAgentCreated?.(data.agent.id);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Agent creation failed");
        } finally {
            setIsSaving(false);
        }
    };

    const resetForm = () => {
        setStep("role");
        setSelectedRole(null);
        setSelectedProvider(providers[0]);
        setName("");
        setMonthlyBudget("");
        setLlmProvider("");
        setError(null);
    };

    const avatarSeed = name.trim() || selectedRole?.title || "agent";

    return (
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetForm(); }}>
            <DialogTrigger asChild>
                <Button variant="default" className="shadow-sm">Hire Agent</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[580px] bg-zinc-950 border-zinc-800 text-zinc-200">
                <DialogHeader>
                    <DialogTitle className="text-zinc-100">
                        {step === "role" && "Pick a role"}
                        {step === "provider" && "How should it run?"}
                        {step === "name" && "Name your agent"}
                    </DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        {step === "role" && "Choose a pre-built role with doctrine files, or start from scratch."}
                        {step === "provider" && "Select the runtime that will execute this agent's work. API keys live in the runtime — not stored in EmperorClaw."}
                        {step === "name" && "Give it a name and review the configuration before creating."}
                    </DialogDescription>
                </DialogHeader>

                {/* Step 1: Role Selection */}
                {step === "role" && (
                    <div className="grid grid-cols-2 gap-2 max-h-[340px] overflow-y-auto py-2">
                        {agentRoleTemplates.map((template) => (
                            <button
                                key={template.id}
                                type="button"
                                onClick={() => handleRoleSelect(template.id)}
                                className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 text-left transition-colors hover:border-cyan-500/40 hover:bg-cyan-500/5 group"
                            >
                                <span className="text-2xl shrink-0">{template.emoji}</span>
                                <div className="min-w-0">
                                    <span className="block text-sm font-medium text-zinc-100 group-hover:text-cyan-200 transition-colors">
                                        {template.title}
                                    </span>
                                    <span className="block text-[11px] leading-tight text-zinc-400 mt-0.5 line-clamp-2">
                                        {template.description}
                                    </span>
                                </div>
                            </button>
                        ))}
                        <button
                            type="button"
                            onClick={() => { setSelectedRole(null); setName(""); setStep("provider"); }}
                            className="flex items-center gap-3 rounded-xl border border-dashed border-zinc-700 bg-zinc-900/40 p-3 text-left transition-colors hover:border-zinc-500 hover:bg-zinc-900/70"
                        >
                            <span className="text-2xl shrink-0">✨</span>
                            <div className="min-w-0">
                                <span className="block text-sm font-medium text-zinc-400">Custom Role</span>
                                <span className="block text-[11px] leading-tight text-zinc-400 mt-0.5">
                                    Blank slate
                                </span>
                            </div>
                        </button>
                    </div>
                )}

                {/* Step 2: Provider Selection */}
                {step === "provider" && (
                    <div className="space-y-2 py-2 max-h-[340px] overflow-y-auto">
                        {selectedRole && (
                            <div className="flex items-center gap-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 mb-3">
                                <span className="text-lg">{selectedRole.emoji}</span>
                                <div>
                                    <span className="text-sm font-medium text-cyan-100">{selectedRole.title}</span>
                                    <span className="block text-[11px] text-cyan-100/60">
                                        {selectedRole.runtime === "any" ? "Works with any runtime" : `Best with ${selectedRole.runtime}`}
                                    </span>
                                </div>
                            </div>
                        )}
                        {/* Hermes prerequisite warning */}
                        {selectedProvider.id === "hermes" && (
                        <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 mb-2">
                            <span className="text-[10px] font-bold text-amber-300 uppercase tracking-wider">⚡ Before you continue</span>
                            <p className="text-[10px] text-amber-200/70 mt-0.5 leading-relaxed">
                                Hermes requires a running bridge on your machine. You'll need Python 3.10+, the Hermes CLI, and an LLM API key.
                                The setup guide appears right after creation — no terminal expertise needed.
                            </p>
                        </div>
                        )}
                        {/* Key guidance for the selected provider */}
                        {selectedProvider.supportsLlmProvider && (
                        <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 mb-2">
                            <span className="text-[10px] font-bold text-amber-300 uppercase tracking-wider">🔑 API Keys</span>
                            <p className="text-[10px] text-amber-200/70 mt-0.5 leading-relaxed">
                                Hermes reads keys from ~/.hermes/.env or your environment. EmperorClaw only stores the provider choice as metadata — the bridge reads it to auto-detect which LLM you're using.
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
                                <span className="text-xl shrink-0 mt-0.5">
                                    {provider.id === "openclaw" ? "🦀" : provider.id === "hermes" ? "👑" : provider.id === "codex" ? "🧠" : "🔌"}
                                </span>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium text-zinc-100">{provider.name}</span>
                                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 uppercase">
                                            {provider.executionModel === "persistent" ? "Daemon" : "On-demand"}
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
                                <img
                                    src={`https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(avatarSeed)}`}
                                    className="w-full h-full object-cover"
                                    alt=""
                                />
                            </div>
                            <div className="flex-1 space-y-1">
                                <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Agent Name</label>
                                <input
                                    className="w-full bg-zinc-900 border-zinc-800 focus:ring-1 focus:ring-cyan-500 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none"
                                    placeholder="e.g. SEO Agent"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    autoFocus
                                />
                            </div>
                        </div>

                        <div className="space-y-3">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Where will this agent run?</label>
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
                                    <span className="text-sm">🌐</span>
                                    <div>
                                        <span className="block font-medium">Another machine</span>
                                        <span className="text-[10px] opacity-70">VPS, Raspberry Pi, dedicated worker</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setDeploymentMode("local")}
                                    disabled={!selectedProvider.supportsLocal}
                                    title={selectedProvider.supportsLocal ? undefined : `${selectedProvider.name} does not support same-server deployment yet`}
                                    className={cn(
                                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                                        !selectedProvider.supportsLocal
                                            ? "border-zinc-800/50 bg-zinc-900/30 text-zinc-500 cursor-not-allowed"
                                            : deploymentMode === "local"
                                                ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-100"
                                                : "border-zinc-800 bg-zinc-900/70 text-zinc-400 hover:border-zinc-600"
                                    )}
                                >
                                    <span className="text-sm">🖥️</span>
                                    <div>
                                        <span className="block font-medium">This server</span>
                                        <span className="text-[10px] opacity-70">Same machine as EmperorClaw</span>
                                    </div>
                                </button>
                            </div>
                        </div>

                        {/* Monthly budget */}
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Monthly Budget (USD)</label>
                            <div className="flex items-center gap-2">
                                <span className="text-zinc-400 text-sm">$</span>
                                <input
                                    type="number"
                                    min="0"
                                    step="1"
                                    className="w-24 bg-zinc-900 border-zinc-800 focus:ring-1 focus:ring-cyan-500 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none"
                                    placeholder="∞"
                                    value={monthlyBudget}
                                    onChange={(e) => setMonthlyBudget(e.target.value)}
                                />
                                <span className="text-[10px] text-zinc-400">Leave empty for unlimited</span>
                            </div>
                        </div>

                        {/* LLM Provider — only for runtimes that read it (Hermes) */}
                        {selectedProvider.supportsLlmProvider && (
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                                LLM Provider <span className="text-zinc-500 font-normal">— Optional metadata</span>
                            </label>
                            <p className="text-[10px] text-zinc-400 -mt-0.5">
                                Which LLM does this agent use? Stored as metadata — the bridge reads it to auto-detect the provider.
                                API keys must be configured in the runtime environment (~/.hermes/.env), not in EmperorClaw.
                            </p>
                            <select
                                value={llmProvider}
                                onChange={(e) => setLlmProvider(e.target.value)}
                                className="h-8 rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-200 outline-none focus:border-cyan-400 mt-1"
                            >
                                <option value="">None</option>
                                <option value="openai">OpenAI</option>
                                <option value="anthropic">Anthropic</option>
                                <option value="google">Google Gemini</option>
                                <option value="openrouter">OpenRouter</option>
                                <option value="grok">Grok</option>
                                <option value="deepseek">DeepSeek</option>
                            </select>
                        </div>
                        )}

                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3 space-y-2">
                            <span className="text-[10px] font-bold text-emerald-300 uppercase tracking-wider">Configuration</span>
                            <div className="grid gap-1.5 text-[11px]">
                                <div className="flex justify-between">
                                    <span className="text-zinc-400">Role</span>
                                    <span className="text-zinc-300">{selectedRole ? `${selectedRole.emoji} ${selectedRole.title}` : "Custom"}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-400">Provider</span>
                                    <span className="text-zinc-300">{selectedProvider.name}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-zinc-400">Deployment</span>
                                    <span className="text-zinc-300">{deploymentMode === "local" ? "🖥️ This server" : "🌐 Remote"}</span>
                                </div>
                                {selectedRole && (
                                    <div className="flex justify-between">
                                        <span className="text-zinc-400">Doctrine</span>
                                        <span className="text-emerald-300">SOUL.md, AGENTS.md, BOOTSTRAP.md, IDENTITY.md</span>
                                    </div>
                                )}
                                <div className="flex justify-between">
                                    <span className="text-zinc-400">Budget</span>
                                    <span className="text-zinc-300">{monthlyBudget ? `$${monthlyBudget}/mo` : "Unlimited"}</span>
                                </div>
                                {llmProvider && (
                                    <div className="flex justify-between">
                                        <span className="text-zinc-400">LLM</span>
                                        <span className="text-emerald-300">{llmProvider}</span>
                                    </div>
                                )}
                            </div>
                        </div>

                        {error && (
                            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div>
                        )}

                        {/* What's next hint */}
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
                            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">After creation</span>
                            <p className="text-[10px] text-zinc-400 mt-0.5 leading-relaxed">
                                {selectedProvider.id === "hermes"
                                    ? "1. Configure your LLM API key in ~/.hermes/.env  2. Start the Hermes bridge  3. Agent appears online"
                                    : "1. Configure your runtime  2. Point it to EmperorClaw's MCP endpoint  3. Agent registers on first heartbeat"}
                            </p>
                            <p className="text-[10px] text-zinc-400 mt-1">
                                <a href="/docs/v1.1/troubleshooting#5-agent-setup--llm-configuration" target="_blank" className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2">
                                    Troubleshooting guide →
                                </a>
                            </p>
                        </div>
                    </div>
                )}

                <DialogFooter className="flex items-center gap-2">
                    {step !== "role" && (
                        <Button type="button" variant="outline" onClick={() => setStep(step === "provider" ? "role" : "provider")}
                            className="border-zinc-800 text-zinc-300 hover:bg-zinc-800">
                            Back
                        </Button>
                    )}
                    <div className="flex-1" />
                    <Button type="button" variant="outline" onClick={() => setOpen(false)} className="border-zinc-800 text-zinc-300 hover:bg-zinc-800">
                        Cancel
                    </Button>
                    {step === "name" && (
                        <Button type="button" onClick={handleCreate} disabled={isSaving || !name.trim()} className="bg-cyan-600 hover:bg-cyan-500 text-white">
                            {isSaving ? "Creating..." : "Hire Agent"}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
