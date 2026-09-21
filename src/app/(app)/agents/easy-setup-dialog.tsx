"use client";

import { useCallback, useEffect, useState } from "react";
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

// Easy Setup deliberately offers only the two providers we support for
// one-click local hiring: OpenRouter (free default model, no billing
// surprise) and DeepSeek. Every other provider stays reachable through the
// Advanced create-agent flow.
const LLM_PROVIDER_OPTIONS: { id: string; label: string }[] = [
    { id: "openrouter", label: "OpenRouter" },
    { id: "deepseek", label: "DeepSeek" },
];

// Default model per provider, so a hired worker can reply without the operator
// knowing a model name. OpenRouter's Nemotron 3 Ultra is free.
const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
    openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free",
    deepseek: "",
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
    localOnly = false,
}: {
    onAgentCreated?: (agentId: string) => void;
    onSwitchToAdvanced: () => void;
    localOnly?: boolean;
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState<EasyStep>("count-and-roles");
    const [count, setCount] = useState(1);
    const [specs, setSpecs] = useState<AgentSpecState[]>([makeSpec(0)]);
    const [llmProvider, setLlmProvider] = useState(DEFAULT_LLM_PROVIDER);
    const [llmApiKey, setLlmApiKey] = useState("");
    const [llmModel, setLlmModel] = useState(DEFAULT_MODEL_BY_PROVIDER[DEFAULT_LLM_PROVIDER]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<AgentBatchResult[] | null>(null);
    const [expanded, setExpanded] = useState<Record<number, boolean>>({});

    const [available, setAvailable] = useState<boolean | null>(null);
    const [availabilityReason, setAvailabilityReason] = useState("");
    const [configurations, setConfigurations] = useState<{ id: string; name: string; llmProvider: string }[]>([]);
    const [sourceAgentId, setSourceAgentId] = useState("");
    const checkAvailability = useCallback(async () => {
        setAvailable(null);
        try {
            const response = await fetch("/api/agents/easy-setup", { cache: "no-store" });
            if (!response.ok) throw new Error("Could not check local setup. Retry below.");
            const data = await response.json();
            setConfigurations(data.configurations || []);
            setAvailable(Boolean(data.available));
            setAvailabilityReason(data.reason || "Local Hermes setup is unavailable. Start Docker and retry.");
        } catch (e) {
            setAvailable(false);
            setAvailabilityReason(e instanceof Error ? e.message : "Could not check local setup.");
        }
    }, []);
    useEffect(() => { if (open) void checkAvailability(); }, [open, checkAvailability]);

    const resetForm = () => {
        setStep("count-and-roles");
        setCount(1);
        setSpecs([makeSpec(0)]);
        setLlmProvider(DEFAULT_LLM_PROVIDER);
        setLlmApiKey("");
        setLlmModel(DEFAULT_MODEL_BY_PROVIDER[DEFAULT_LLM_PROVIDER]);
        setSourceAgentId("");
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
        if (submitting || available !== true) return;
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
                    agents: specs.map((s) => {
                        const template = s.templateId ? getAgentTemplate(s.templateId) : null;
                        return { role: s.role, name: s.name.trim() || s.role, doctrineJson: template ? {
                            "SOUL.md": template.soul, "AGENTS.md": template.agents, "BOOTSTRAP.md": template.bootstrap, "IDENTITY.md": template.identity,
                        } : {} };
                    }),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Easy Setup failed");
            const batch: AgentBatchResult[] = data.results || [];
            setResults(batch);
            setExpanded(Object.fromEntries(batch.map((r: AgentBatchResult, i: number) => [i, !r.success])));
            setStep("done");
            const created = batch.find((r: AgentBatchResult) => r.success && r.agentId);
            if (created?.agentId) {
                // Only clear the key and advance once a worker actually came up.
                // A failed runtime download used to still advance, stranding the
                // operator on an agent stuck at "disconnected" with no retry.
                setLlmApiKey("");
                onAgentCreated?.(created.agentId);
            }
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Easy Setup failed");
            setStep("provider-key");
        } finally {
            setSubmitting(false);
        }
    };

    const handleViewAgents = () => {
        const firstSuccess = results?.find((r) => r.success && r.agentId) || results?.find((r) => r.agentId);
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
        <Dialog open={open} onOpenChange={(o) => { if (submitting) return; setOpen(o); if (!o) resetForm(); }}>
            <DialogTrigger asChild>
                <Button variant="default" className="shadow-sm">➕ Hire an Agent</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[580px] bg-zinc-950 border-zinc-800 text-zinc-200">
                <DialogHeader>
                    <DialogTitle className="text-zinc-100">
                        {step === "count-and-roles" && "Hire a local Hermes agent"}
                        {step === "provider-key" && "Connect an LLM provider"}
                        {step === "provisioning" && "Provisioning agents…"}
                        {step === "done" && "Setup results"}
                    </DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        {step === "count-and-roles" && "Choose a role and name. Emperor installs and connects Hermes on this server."}
                        {step === "provider-key" && "Your provider runs the model and bills its usage. Emperor encrypts this key and configures the workers for you."}
                        {step === "provisioning" && "Keep this window open while each worker is installed and started. The first download may take a few minutes."}
                        {step === "done" && "Here's what happened for each agent in this batch."}
                    </DialogDescription>
                </DialogHeader>

                {step !== "provisioning" && step !== "done" && available !== true && (
                    <div className="rounded-lg border border-amber-500/20 px-3 py-2 text-sm text-amber-200" role="status">
                        {available === null ? "Checking local Hermes setup…" : <>
                            <p>{availabilityReason}</p>
                            <div className="mt-2 flex gap-3">
                                <button type="button" onClick={() => void checkAvailability()} className="underline">Retry</button>
                                <a href="/docs/v1.1/installation" target="_blank" rel="noreferrer" className="underline">Docker setup guide</a>
                            </div>
                        </>}
                    </div>
                )}

                {/* Step: count-and-roles */}
                {step === "count-and-roles" && (
                    <div className="space-y-4 py-2">
                        <details className="text-sm text-zinc-400">
                            <summary className="cursor-pointer">Hire more than one agent</summary>
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

                        </details>

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
                        {configurations.length > 0 && (
                            <label className="block space-y-2 text-sm text-zinc-300">
                                LLM connection
                                <select value={sourceAgentId} onChange={e => setSourceAgentId(e.target.value)} className="block w-full rounded-lg border border-zinc-800 bg-zinc-900 p-2">
                                    <option value="">Enter a provider API key</option>
                                    {configurations.map(c => <option key={c.id} value={c.id}>Reuse {c.name} · {c.llmProvider}</option>)}
                                </select>
                                <span className="block text-xs text-zinc-500">{sourceAgentId ? "Uses that agent’s saved provider, model, key, and access scope." : "Enter a new key, or reuse a saved connection."}</span>
                            </label>
                        )}
                        {!sourceAgentId && <>
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">LLM Provider</label>
                            <div className="grid grid-cols-2 gap-2">
                                {LLM_PROVIDER_OPTIONS.map((p) => (
                                    <button
                                        key={p.id}
                                        type="button"
                                        onClick={() => { setLlmProvider(p.id); setLlmModel(DEFAULT_MODEL_BY_PROVIDER[p.id] ?? ""); }}
                                        className={cn(
                                            "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                                            llmProvider === p.id
                                                ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100"
                                                : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-600"
                                        )}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">API Key</label>
                            <input
                                type="password"
                                value={llmApiKey}
                                onChange={(e) => setLlmApiKey(e.target.value)}
                                placeholder="Paste your provider API key"
                                aria-label="LLM provider API key"
                                autoComplete="off"
                                className="w-full bg-zinc-900 border-zinc-800 focus:ring-1 focus:ring-cyan-500 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none"
                            />
                        </div>
                        <label className="block space-y-1.5 text-sm text-zinc-300">
                            Model <span className="text-zinc-500">(optional)</span>
                            <input value={llmModel} onChange={e => setLlmModel(e.target.value)} maxLength={200}
                                placeholder={DEFAULT_MODEL_BY_PROVIDER[llmProvider] || "Use the provider default"} className="block w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100" />
                        </label>
                        <p className="text-xs text-zinc-500">
                            Emperor encrypts and stores your key, then configures Hermes automatically.
                            {specs.length > 1 && " All agents in this batch use this connection."}
                        </p>
                        </>}
                        {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
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
                        {successCount === 0 && (
                            <p className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 text-xs text-amber-200">
                                Nothing came up. The first run downloads the runtime image (about 3 GB), which can time out on a slow link — retrying usually finishes from the already-downloaded layers.
                            </p>
                        )}
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
                                            {r.success ? "✓ started" : "✕ failed"}
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
                    {step === "provider-key" && (
                        <Button type="button" variant="outline" onClick={() => setStep("count-and-roles")} className="border-zinc-800 text-zinc-300 hover:bg-zinc-800">Back</Button>
                    )}
                    {step === "count-and-roles" && !localOnly && (
                        <button type="button" onClick={handleAdvanced} className="text-xs text-zinc-400 underline hover:text-zinc-200">Connect a remote agent instead</button>
                    )}
                    <div className="flex-1" />
                    {step !== "provisioning" && step !== "done" && (
                        <Button type="button" variant="outline" onClick={() => { setOpen(false); resetForm(); }} className="border-zinc-800 text-zinc-300 hover:bg-zinc-800">Cancel</Button>
                    )}
                    {step === "count-and-roles" && (
                        <Button type="button" onClick={() => setStep("provider-key")} disabled={!canContinueRoles} className="bg-cyan-600 hover:bg-cyan-500 text-white">Continue</Button>
                    )}
                    {step === "provider-key" && (
                        <Button type="button" onClick={handleCreate} disabled={submitting || available !== true || (!sourceAgentId && !llmApiKey.trim())} className="bg-cyan-600 hover:bg-cyan-500 text-white">
                            Create &amp; start {specs.length === 1 ? "agent" : `${specs.length} agents`}
                        </Button>
                    )}
                    {step === "done" && successCount === 0 && (
                        <Button
                            type="button"
                            onClick={handleCreate}
                            disabled={submitting || available !== true || (!sourceAgentId && !llmApiKey.trim())}
                            className="bg-cyan-600 hover:bg-cyan-500 text-white"
                        >
                            Retry provisioning
                        </Button>
                    )}
                    {step === "done" && successCount > 0 && (
                        <Button type="button" onClick={handleViewAgents} className="bg-cyan-600 hover:bg-cyan-500 text-white">
                            {results?.length === 1 ? "Open agent" : "View agents"}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
