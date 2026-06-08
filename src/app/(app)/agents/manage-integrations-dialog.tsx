"use client";

import { useCallback, useEffect, useState } from "react";
import { Key, Plus, Settings2, ShieldCheck, Trash2, X } from "lucide-react";
import { deleteAgentIntegration, getAgentIntegrations, getSecretManagerStatus, saveAgentIntegration } from "@/app/actions/integrations";

const PROVIDER_TEMPLATES: Record<string, {
    provider: string;
    configJson: string;
    secretJson: string;
    description: string;
}> = {
    generic: {
        provider: "generic",
        configJson: JSON.stringify({ baseUrl: "https://api.example.com", accountId: "acct_123" }, null, 2),
        secretJson: JSON.stringify({ token: "replace_me" }, null, 2),
        description: "Generic runtime-local payload. Use this when the local worker needs arbitrary connector data that does not belong in Knowledge & Rules.",
    },
    webhook: {
        provider: "webhook",
        configJson: JSON.stringify({ endpoint: "https://hooks.example.com/events", method: "POST" }, null, 2),
        secretJson: JSON.stringify({ authorization: "Bearer replace_me" }, null, 2),
        description: "Webhook-style runtime payload for machine-local outbound hooks.",
    },
    github: {
        provider: "github",
        configJson: JSON.stringify({ owner: "acme", repo: "control-plane" }, null, 2),
        secretJson: JSON.stringify({ token: "ghp_replace_me" }, null, 2),
        description: "Use per-agent GitHub credentials only when they are truly runtime-local. Shared repository access usually belongs in Knowledge & Rules.",
    },
    slack: {
        provider: "slack",
        configJson: JSON.stringify({ channel: "#ops" }, null, 2),
        secretJson: JSON.stringify({ botToken: "xoxb-replace_me" }, null, 2),
        description: "Runtime-local Slack bot or webhook data.",
    },
    smtp: {
        provider: "email_smtp",
        configJson: JSON.stringify({ host: "smtp.example.com", port: 465, username: "ops@example.com" }, null, 2),
        secretJson: JSON.stringify({ password: "replace_me" }, null, 2),
        description: "Use SMTP here only when the mailbox is truly tied to this machine-local worker. Customer and project mailboxes should be stored in Knowledge & Rules instead.",
    },
    imap: {
        provider: "email_imap",
        configJson: JSON.stringify({ host: "imap.example.com", port: 993, username: "ops@example.com" }, null, 2),
        secretJson: JSON.stringify({ password: "replace_me" }, null, 2),
        description: "Use IMAP here only for agent-local mailboxes. Prefer project or customer entries in Knowledge & Rules for shared inboxes.",
    },
};

function parseJsonObject(input: string, label: string) {
    try {
        const parsed = JSON.parse(input);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(`${label} must be a JSON object.`);
        }
        return parsed as Record<string, unknown>;
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : `Invalid ${label}.`);
    }
}

function summarizeConfig(configJson: unknown) {
    if (!configJson || typeof configJson !== "object") return null;
    const config = configJson as Record<string, unknown>;
    for (const key of ["username", "accountId", "channel", "endpoint", "owner"]) {
        const value = config[key];
        if (typeof value === "string" && value.trim().length > 0) return `${key}: ${value}`;
    }
    return null;
}

export function ManageIntegrationsDialog({ agentId }: { agentId: string }) {
    const [isOpen, setIsOpen] = useState(false);
    const [integrations, setIntegrations] = useState<Awaited<ReturnType<typeof getAgentIntegrations>>>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [managerEnabled, setManagerEnabled] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);

    const [template, setTemplate] = useState("generic");
    const [provider, setProvider] = useState(PROVIDER_TEMPLATES.generic.provider);
    const [name, setName] = useState("");
    const [configJson, setConfigJson] = useState(PROVIDER_TEMPLATES.generic.configJson);
    const [secretJson, setSecretJson] = useState(PROVIDER_TEMPLATES.generic.secretJson);

    const loadIntegrations = useCallback(async () => {
        setIsLoading(true);
        try {
            const [data, status] = await Promise.all([
                getAgentIntegrations(agentId),
                getSecretManagerStatus(),
            ]);
            setIntegrations(data);
            setManagerEnabled(status.enabled);
        } catch (error) {
            console.error("Failed to fetch runtime integrations", error);
        } finally {
            setIsLoading(false);
        }
    }, [agentId]);

    useEffect(() => {
        if (isOpen) {
            void loadIntegrations();
        }
    }, [isOpen, loadIntegrations]);

    const applyTemplate = (nextTemplate: string) => {
        const resolved = PROVIDER_TEMPLATES[nextTemplate] || PROVIDER_TEMPLATES.generic;
        setTemplate(nextTemplate);
        setProvider(resolved.provider);
        setConfigJson(resolved.configJson);
        setSecretJson(resolved.secretJson);
        setFormError(null);
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);
        setFormError(null);

        try {
            const parsedConfig = parseJsonObject(configJson, "Config JSON");
            const parsedSecrets = parseJsonObject(secretJson, "Secret JSON");
            await saveAgentIntegration({
                agentId,
                provider: provider.trim() || "generic",
                name: name.trim(),
                configJson: parsedConfig,
                secretJson: parsedSecrets,
            });

            setName("");
            applyTemplate("generic");
            await loadIntegrations();
        } catch (error) {
            setFormError(error instanceof Error ? error.message : "Failed to save runtime integration.");
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("Archive this runtime integration?")) return;
        try {
            await deleteAgentIntegration(id);
            await loadIntegrations();
        } catch (error) {
            console.error("Failed to archive runtime integration", error);
        }
    };

    const activeTemplate = PROVIDER_TEMPLATES[template] || PROVIDER_TEMPLATES.generic;

    return (
        <>
            <button
                onClick={() => setIsOpen(true)}
                className="mt-4 w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-4 py-2 rounded-lg text-xs font-semibold flex items-center justify-center transition-colors border border-zinc-700/50"
            >
                <Settings2 className="w-3.5 h-3.5 mr-2" />
                Advanced Runtime Integrations
            </button>

            {isOpen && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
                    <div className="bg-zinc-950 border border-zinc-800 shadow-2xl rounded-2xl w-full max-w-3xl overflow-hidden animate-in zoom-in-95 duration-200 max-h-[90vh] flex flex-col">
                        <div className="flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-900/50">
                            <h3 className="text-lg font-semibold text-zinc-100 flex items-center">
                                <ShieldCheck className="w-5 h-5 text-emerald-400 mr-2" />
                                Agent Runtime Integrations
                            </h3>
                            <button
                                onClick={() => setIsOpen(false)}
                                className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-500 transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-6 space-y-8">
                            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100/90">
                                Runtime integrations are advanced, agent-bound payloads. They are not automatically injected into Hermes/OpenClaw prompts.
                                A trusted runtime must explicitly list them and lease one through the MCP integration endpoints when it needs that tool credential.
                                Customer mailboxes, project identities, invoice templates, and shared external accounts belong in <span className="font-semibold text-white">Knowledge & Rules</span>.
                            </div>

                            <section>
                                <h4 className="text-sm font-semibold text-zinc-400 mb-4 flex items-center">
                                    <Key className="w-4 h-4 mr-2" /> Active Runtime Integrations
                                </h4>
                                {isLoading ? (
                                    <div className="text-zinc-500 text-sm animate-pulse">Loading...</div>
                                ) : integrations.length === 0 ? (
                                    <div className="text-zinc-600 text-sm italic py-4 bg-zinc-900/30 rounded-lg border border-dashed border-zinc-800 text-center">
                                        No runtime integrations configured for this agent.
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 gap-3">
                                        {integrations.map((integration) => (
                                            <div key={integration.id} className="bg-zinc-900 border border-zinc-800 p-4 rounded-xl flex items-center justify-between group gap-4">
                                                <div className="space-y-1">
                                                    <div className="text-sm font-medium text-zinc-200">{integration.name}</div>
                                                    <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase font-bold tracking-wider text-zinc-500">
                                                        <span>{integration.provider}</span>
                                                        <span className="text-zinc-700">*</span>
                                                        <span>{integration.ownership}</span>
                                                        {summarizeConfig(integration.configJson) && (
                                                            <>
                                                                <span className="text-zinc-700">*</span>
                                                                <span className="normal-case tracking-normal text-zinc-400">{summarizeConfig(integration.configJson)}</span>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={() => handleDelete(integration.id)}
                                                    className="p-2 text-zinc-600 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-all font-semibold text-[10px] flex items-center"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5 mr-1" />
                                                    Archive
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </section>

                            <section className="pt-6 border-t border-zinc-800/50">
                                <h4 className="text-sm font-semibold text-zinc-400 mb-4 flex items-center">
                                    <Plus className="w-4 h-4 mr-2" /> Add Runtime Payload
                                </h4>
                                <form onSubmit={handleSave} className="space-y-4 bg-zinc-900/40 p-5 rounded-2xl border border-zinc-800">
                                    <div className="grid grid-cols-2 gap-4">
                                        <label className="space-y-1.5">
                                            <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Template</span>
                                            <select
                                                value={template}
                                                onChange={(event) => applyTemplate(event.target.value)}
                                                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-300 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
                                            >
                                                <option value="generic">Generic Runtime Payload</option>
                                                <option value="webhook">Webhook</option>
                                                <option value="github">GitHub</option>
                                                <option value="slack">Slack</option>
                                                <option value="smtp">SMTP</option>
                                                <option value="imap">IMAP</option>
                                            </select>
                                        </label>
                                        <label className="space-y-1.5">
                                            <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Label</span>
                                            <input
                                                type="text"
                                                required
                                                value={name}
                                                onChange={(event) => setName(event.target.value)}
                                                placeholder="e.g. local-build-bot, github-runtime, ops-webhook"
                                                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                            />
                                        </label>
                                    </div>

                                    <label className="space-y-1.5 block">
                                        <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Provider</span>
                                        <input
                                            type="text"
                                            value={provider}
                                            onChange={(event) => setProvider(event.target.value)}
                                            placeholder="generic, webhook, github, email_smtp..."
                                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                        />
                                    </label>

                                    <p className="text-[11px] text-zinc-500 leading-relaxed">
                                        {activeTemplate.description}
                                    </p>

                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                        <label className="space-y-1.5">
                                            <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Config JSON</span>
                                            <textarea
                                                value={configJson}
                                                onChange={(event) => setConfigJson(event.target.value)}
                                                className="min-h-[220px] w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-sm font-mono text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                            />
                                        </label>
                                        <label className="space-y-1.5">
                                            <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Secret JSON</span>
                                            <textarea
                                                value={secretJson}
                                                onChange={(event) => setSecretJson(event.target.value)}
                                                className="min-h-[220px] w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-sm font-mono text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                            />
                                        </label>
                                    </div>

                                    <div className={`p-3 rounded-xl border mb-2 flex items-center space-x-3 ${managerEnabled ? "bg-emerald-950/20 border-emerald-800" : "bg-amber-950/20 border-amber-800"}`}>
                                        <ShieldCheck className={`w-5 h-5 ${managerEnabled ? "text-emerald-500" : "text-amber-500"}`} />
                                        <div>
                                            <div className={`text-xs font-bold ${managerEnabled ? "text-emerald-400" : "text-amber-400"}`}>
                                                {managerEnabled ? "Secure Managed Storage Active" : "Managed Storage Offline"}
                                            </div>
                                            <p className="text-[10px] text-zinc-500 mt-0.5 leading-relaxed">
                                                {managerEnabled
                                                    ? "Secrets are encrypted server-side. The runtime receives only the leased payload it is authorized to use."
                                                    : "No master key is configured. Store only metadata here or keep the actual secret local to the OpenClaw machine."}
                                            </p>
                                        </div>
                                    </div>

                                    {formError && (
                                        <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-300">
                                            {formError}
                                        </div>
                                    )}

                                    <button
                                        type="submit"
                                        disabled={isSaving || !name.trim()}
                                        className="w-full bg-emerald-500 hover:bg-emerald-400 text-emerald-950 px-4 py-2.5 rounded-lg text-sm font-bold tracking-tight transition-all shadow-lg shadow-emerald-500/20 disabled:opacity-50"
                                    >
                                        {isSaving ? "Saving..." : "Save Runtime Integration"}
                                    </button>
                                </form>
                            </section>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
