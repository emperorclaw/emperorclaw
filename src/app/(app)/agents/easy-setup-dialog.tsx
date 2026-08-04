"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RoleTemplatePicker } from "./role-template-picker";
import { SetupOutputLog, type SetupOutputEntry } from "@/components/setup-output-log";
import { getAgentTemplate } from "@/lib/agent-templates";
import { cn } from "@/lib/utils";

// Matches MAX_EASY_SETUP_AGENTS in src/app/api/agents/easy-setup/route.ts — kept
// as a local constant (not imported) so this client component doesn't pull in
// server-only route dependencies.
const MAX_EASY_SETUP_AGENTS = 10;

// Same 6-provider whitelist used by create-agent-dialog.tsx and
// agent-detail-panel.tsx's LLM provider selects.
const LLM_PROVIDER_OPTIONS: { id: string; label: string }[] = [
    { id: "openai", label: "OpenAI" },
    { id: "anthropic", label: "Anthropic" },
    { id: "google", label: "Google Gemini" },
    { id: "openrouter", label: "OpenRouter" },
    { id: "grok", label: "Grok" },
    { id: "deepseek", label: "DeepSeek" },
];

type EasyStep = "mode" | "count-and-roles" | "provider-key" | "review" | "provisioning" | "done";

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
};

function makeSpec(index: number): AgentSpecState {
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `spec-${index}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
}: {
    onAgentCreated?: (agentId: string) => void;
    onSwitchToAdvanced: () => void;
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState<EasyStep>("mode");
    const [count, setCount] = useState(1);
    const [specs, setSpecs] = useState<AgentSpecState[]>([makeSpec(0)]);
    const [llmProvider, setLlmProvider] = useState(LLM_PROVIDER_OPTIONS[0].id);
    const [llmApiKey, setLlmApiKey] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<AgentBatchResult[] | null>(null);
    const [expanded, setExpanded] = useState<Record<number, boolean>>({});

    const resetForm = () => {
        setStep("mode");
        setCount(1);
        setSpecs([makeSpec(0)]);
        setLlmProvider(LLM_PROVIDER_OPTIONS[0].id);
        setLlmApiKey("");
        setSubmitting(false);
        setError(null);
        setResults(null);
        setExpanded({});
    };

    const handleCountChange = (nextCount: number) => {
        const clamped = Math.max(1, Math.min(MAX_EASY_SETUP_AGENTS, Number.isFinite(nextCount) ? nextCount : 1));
        setCount(clamped);
        setSpecs((prev) => resizeSpecs(prev, clamped));
    };

    const updateSpec = (id: string, fields: Partial<AgentSpecState>) => {
        setSpecs((prev) => prev.map((s) => (s.id === id ? { ...s, ...fields } : s)));
    };

    const handleCreate = async () => {
        setStep("provisioning");
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch("/api/agents/easy-setup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    llmProvider,
                    llmApiKey,
                    agents: specs.map((s) => ({ role: s.role, name: s.name.trim() || s.role })),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Easy Setup failed");
            setResults(data.results || []);
            setStep("done");
        } catch (e) {
            setError(e instanceof Error ? e.message : "Easy Setup failed");
            setStep("review");
        } finally {
            setSubmitting(false);
        }
    };

    const handleViewAgents = () => {
        const firstSuccess = results?.find((r) => r.success && r.agentId);
        setOpen(false);
        resetForm();
        router.refresh();
        if (firstSuccess?.agentId) onAgentCreated?.(firstSuccess.agentId);
    };

    const handleAdvanced = () => {
        setOpen(false);
        resetForm();
        onSwitchToAdvanced();
    };

    const successCount = results?.filter((r) => r.success).length ?? 0;
    const canContinueRoles = specs.every((s) => s.name.trim().length > 0);

    return (
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetForm(); }}>
            <DialogTrigger asChild>
                <Button variant="default" className="shadow-sm">⚡ Easy Setup</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[580px] bg-zinc-950 border-zinc-800 text-zinc-200">
                <DialogHeader>
                    <DialogTitle className="text-zinc-100">
                        {step === "mode" && "How do you want to set up agents?"}
                        {step === "count-and-roles" && "How many agents, and what roles?"}
                        {step === "provider-key" && "Connect an LLM provider"}
                        {step === "review" && "Review & create"}
                        {step === "provisioning" && "Provisioning agents…"}
                        {step === "done" && "Easy Setup complete"}
                    </DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        {step === "mode" && "Easy Setup runs Hermes agents as sibling Docker containers on this machine — no CLI required."}
                        {step === "count-and-roles" && `Pick a role for each agent. Up to ${MAX_EASY_SETUP_AGENTS} per batch.`}
                        {step === "provider-key" && "This key will be used to run every agent in this batch."}
                        {step === "review" && "Confirm the agents you're about to create."}
                        {step === "provisioning" && "This runs synchronously — hang tight, this can take a moment per agent."}
                        {step === "done" && "Here's what happened for each agent in this batch."}
                    </DialogDescription>
                </DialogHeader>

                {/* Step: mode */}
                {step === "mode" && (
                    <div className="grid grid-cols-1 gap-3 py-2">
                        <button
                            type="button"
                            onClick={() => setStep("count-and-roles")}
                            className="flex items-start gap-3 rounded-xl border border-cyan-500/30 bg-cyan-500/[0.06] p-4 text-left transition-colors hover:border-cyan-400/50 hover:bg-cyan-500/10"
                        >
                            <span className="text-2xl shrink-0">⚡</span>
                            <div>
                                <span className="block text-sm font-medium text-cyan-100">Easy Setup (Hermes, this machine)</span>
                                <span className="block text-[11px] leading-relaxed text-cyan-100/60 mt-0.5">
                                    Pick roles, provide one LLM key, and EmperorClaw provisions isolated Hermes containers for you automatically.
                                </span>
                            </div>
                        </button>
                        <button
                            type="button"
                            onClick={handleAdvanced}
                            className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 text-left transition-colors hover:border-zinc-600 hover:bg-zinc-900"
                        >
                            <span className="text-2xl shrink-0">🛠️</span>
                            <div>
                                <span className="block text-sm font-medium text-zinc-100">Advanced</span>
                                <span className="block text-[11px] leading-relaxed text-zinc-400 mt-0.5">
                                    Manual setup, OpenClaw, or Hermes on a separate machine — full control over runtime and provider.
                                </span>
                            </div>
                        </button>
                    </div>
                )}

                {/* Step: count-and-roles */}
                {step === "count-and-roles" && (
                    <div className="space-y-4 py-2">
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">How many agents?</label>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => handleCountChange(count - 1)}
                                    disabled={count <= 1}
                                    className="h-8 w-8 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    −
                                </button>
                                <input
                                    type="number"
                                    min={1}
                                    max={MAX_EASY_SETUP_AGENTS}
                                    value={count}
                                    onChange={(e) => handleCountChange(parseInt(e.target.value, 10))}
                                    className="w-16 bg-zinc-900 border border-zinc-800 focus:ring-1 focus:ring-cyan-500 rounded-lg px-3 py-1.5 text-sm text-zinc-100 outline-none text-center"
                                />
                                <button
                                    type="button"
                                    onClick={() => handleCountChange(count + 1)}
                                    disabled={count >= MAX_EASY_SETUP_AGENTS}
                                    className="h-8 w-8 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    +
                                </button>
                                {count >= MAX_EASY_SETUP_AGENTS && (
                                    <span className="text-[10px] text-amber-300">Max {MAX_EASY_SETUP_AGENTS} agents per batch</span>
                                )}
                            </div>
                        </div>

                        <div className="space-y-3 max-h-[380px] overflow-y-auto pr-1">
                            {specs.map((spec, i) => (
                                <div key={spec.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 space-y-2">
                                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Agent {i + 1}</span>
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
                                    />
                                    <input
                                        className="w-full bg-zinc-900 border-zinc-800 focus:ring-1 focus:ring-cyan-500 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none"
                                        placeholder="Agent name"
                                        value={spec.name}
                                        onChange={(e) => updateSpec(spec.id, { name: e.target.value })}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Step: provider-key */}
                {step === "provider-key" && (
                    <div className="space-y-4 py-2">
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">LLM Provider</label>
                            <select
                                value={llmProvider}
                                onChange={(e) => setLlmProvider(e.target.value)}
                                className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-sm text-zinc-200 outline-none focus:border-cyan-400"
                            >
                                {LLM_PROVIDER_OPTIONS.map((p) => (
                                    <option key={p.id} value={p.id}>{p.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">API Key</label>
                            <input
                                type="password"
                                value={llmApiKey}
                                onChange={(e) => setLlmApiKey(e.target.value)}
                                placeholder="sk-..."
                                autoComplete="off"
                                className="w-full bg-zinc-900 border-zinc-800 focus:ring-1 focus:ring-cyan-500 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none"
                            />
                        </div>
                        <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2">
                            <span className="text-[10px] font-bold text-amber-300 uppercase tracking-wider">🔑 Shared key</span>
                            <p className="text-[10px] text-amber-200/70 mt-0.5 leading-relaxed">
                                This key is shared across all {specs.length} agent{specs.length === 1 ? "" : "s"} in this batch and encrypted
                                at rest (AES-256-GCM). You can give any agent its own key later from its detail page.
                            </p>
                        </div>
                    </div>
                )}

                {/* Step: review */}
                {step === "review" && (
                    <div className="space-y-4 py-2">
                        <div className="rounded-xl border border-zinc-800 overflow-hidden">
                            <table className="w-full text-xs">
                                <thead className="bg-zinc-900/70 text-zinc-500">
                                    <tr>
                                        <th className="text-left font-medium px-3 py-2">Name</th>
                                        <th className="text-left font-medium px-3 py-2">Role</th>
                                        <th className="text-left font-medium px-3 py-2">Provider</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {specs.map((spec) => (
                                        <tr key={spec.id} className="border-t border-zinc-800/70">
                                            <td className="px-3 py-2 text-zinc-200">{spec.name.trim() || spec.role}</td>
                                            <td className="px-3 py-2 text-zinc-400">{spec.role}</td>
                                            <td className="px-3 py-2 text-zinc-400">
                                                {LLM_PROVIDER_OPTIONS.find((p) => p.id === llmProvider)?.label || llmProvider}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {error && (
                            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div>
                        )}
                    </div>
                )}

                {/* Step: provisioning */}
                {step === "provisioning" && (
                    <div className="flex flex-col items-center justify-center gap-3 py-10 text-zinc-400">
                        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-cyan-400" />
                        <span className="text-sm">Provisioning {specs.length} agent{specs.length === 1 ? "" : "s"}…</span>
                    </div>
                )}

                {/* Step: done */}
                {step === "done" && results && (
                    <div className="space-y-3 py-2">
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-200">
                            {successCount} of {results.length} agent{results.length === 1 ? "" : "s"} provisioned successfully
                        </div>
                        <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                            {results.map((r, i) => (
                                <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setExpanded((prev) => ({ ...prev, [i]: !prev[i] }))}
                                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
                                    >
                                        <span className="text-sm text-zinc-200">{r.name}</span>
                                        <span className={cn(
                                            "rounded-full px-2 py-0.5 text-[10px] font-medium",
                                            r.success ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"
                                        )}>
                                            {r.success ? "✓ online" : "✕ failed"}
                                        </span>
                                    </button>
                                    {expanded[i] && (
                                        <div className="px-3 pb-3 space-y-2">
                                            <p className="text-[11px] text-zinc-400">{r.message}</p>
                                            <SetupOutputLog outputs={r.outputs} />
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <DialogFooter className="flex items-center gap-2">
                    {(step === "count-and-roles" || step === "provider-key" || step === "review") && (
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setStep(
                                step === "count-and-roles" ? "mode" :
                                step === "provider-key" ? "count-and-roles" :
                                "provider-key"
                            )}
                            className="border-zinc-800 text-zinc-300 hover:bg-zinc-800"
                        >
                            Back
                        </Button>
                    )}
                    <div className="flex-1" />
                    {step !== "provisioning" && step !== "done" && (
                        <Button type="button" variant="outline" onClick={() => setOpen(false)} className="border-zinc-800 text-zinc-300 hover:bg-zinc-800">
                            Cancel
                        </Button>
                    )}
                    {step === "count-and-roles" && (
                        <Button type="button" onClick={() => setStep("provider-key")} disabled={!canContinueRoles} className="bg-cyan-600 hover:bg-cyan-500 text-white">
                            Continue
                        </Button>
                    )}
                    {step === "provider-key" && (
                        <Button type="button" onClick={() => setStep("review")} disabled={!llmApiKey.trim()} className="bg-cyan-600 hover:bg-cyan-500 text-white">
                            Continue
                        </Button>
                    )}
                    {step === "review" && (
                        <Button type="button" onClick={handleCreate} disabled={submitting} className="bg-cyan-600 hover:bg-cyan-500 text-white">
                            Create {specs.length} agent{specs.length === 1 ? "" : "s"}
                        </Button>
                    )}
                    {step === "done" && (
                        <Button type="button" onClick={handleViewAgents} className="bg-cyan-600 hover:bg-cyan-500 text-white">
                            View agents
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
