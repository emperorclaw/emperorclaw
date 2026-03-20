"use client";

import { useState, useEffect } from "react";
import { Settings2, Plus, X, Trash2, Key, Mail, ShieldCheck } from "lucide-react";
import { getAgentIntegrations, saveAgentIntegration, deleteAgentIntegration } from "@/app/actions/integrations";

export function ManageIntegrationsDialog({ agentId }: { agentId: string }) {
    const [isOpen, setIsOpen] = useState(false);
    const [integrations, setIntegrations] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const [provider, setProvider] = useState("email_smtp");
    const [name, setName] = useState("");
    const [host, setHost] = useState("");
    const [port, setPort] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");

    const fetchIntegrations = async () => {
        setIsLoading(true);
        try {
            const data = await getAgentIntegrations(agentId);
            setIntegrations(data);
        } catch (error) {
            console.error("Failed to fetch integrations", error);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            fetchIntegrations();
        }
    }, [isOpen, agentId]);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);
        try {
            await saveAgentIntegration({
                agentId,
                provider,
                name,
                configJson: { host, port, username },
                secretJson: { password }
            });
            setName("");
            setHost("");
            setPort("");
            setUsername("");
            setPassword("");
            await fetchIntegrations();
        } catch (error) {
            console.error("Failed to save integration", error);
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("Are you sure you want to delete this integration?")) return;
        try {
            await deleteAgentIntegration(id);
            await fetchIntegrations();
        } catch (error) {
            console.error("Failed to delete integration", error);
        }
    };

    return (
        <>
            <button
                onClick={() => setIsOpen(true)}
                className="mt-4 w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-4 py-2 rounded-lg text-xs font-semibold flex items-center justify-center transition-colors border border-zinc-700/50"
            >
                <Settings2 className="w-3.5 h-3.5 mr-2" />
                Manage Integrations
            </button>

            {isOpen && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
                    <div className="bg-zinc-950 border border-zinc-800 shadow-2xl rounded-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95 duration-200 max-h-[90vh] flex flex-col">
                        <div className="flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-900/50">
                            <h3 className="text-lg font-semibold text-zinc-100 flex items-center">
                                <ShieldCheck className="w-5 h-5 text-emerald-400 mr-2" />
                                Agent Integrations & Secrets
                            </h3>
                            <button
                                onClick={() => setIsOpen(false)}
                                className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-500 transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-6 space-y-8">
                            <section>
                                <h4 className="text-sm font-semibold text-zinc-400 mb-4 flex items-center">
                                    <Key className="w-4 h-4 mr-2" /> Active Credentials
                                </h4>
                                {isLoading ? (
                                    <div className="text-zinc-500 text-sm animate-pulse">Loading...</div>
                                ) : integrations.length === 0 ? (
                                    <div className="text-zinc-600 text-sm italic py-4 bg-zinc-900/30 rounded-lg border border-dashed border-zinc-800 text-center">
                                        No active integrations configured for this agent.
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 gap-3">
                                        {integrations.map((integration) => (
                                            <div key={integration.id} className="bg-zinc-900 border border-zinc-800 p-4 rounded-xl flex items-center justify-between group">
                                                <div className="flex items-center space-x-3">
                                                    <div className="p-2 bg-zinc-800 rounded-lg">
                                                        {integration.provider.includes("email") ? <Mail className="w-4 h-4 text-indigo-400" /> : <Settings2 className="w-4 h-4 text-zinc-400" />}
                                                    </div>
                                                    <div>
                                                        <div className="text-sm font-medium text-zinc-200">{integration.name}</div>
                                                        <div className="flex items-center space-x-2">
                                                            <div className="text-[10px] uppercase font-bold tracking-wider text-zinc-500">{integration.provider}</div>
                                                            <span className="text-zinc-700 text-[10px]">•</span>
                                                            <span className="text-[10px] uppercase font-bold tracking-wider text-zinc-500">{integration.ownership}</span>
                                                            {integration.configJson?.username && (
                                                                <>
                                                                    <span className="text-zinc-700 text-[10px]">•</span>
                                                                    <span className="text-[10px] text-zinc-400 font-mono">{integration.configJson.username}</span>
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={() => handleDelete(integration.id)}
                                                    className="p-2 text-zinc-600 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-all font-semibold text-[10px] flex items-center"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5 mr-1" />
                                                    Remove
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </section>

                            <section className="pt-6 border-t border-zinc-800/50">
                                <h4 className="text-sm font-semibold text-zinc-400 mb-4 flex items-center">
                                    <Plus className="w-4 h-4 mr-2" /> Add New Provider
                                </h4>
                                <form onSubmit={handleSave} className="space-y-4 bg-zinc-900/40 p-5 rounded-2xl border border-zinc-800">
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-1.5">
                                            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Provider</label>
                                            <select
                                                value={provider}
                                                onChange={(e) => setProvider(e.target.value)}
                                                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-300 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
                                            >
                                                <optgroup label="Email Channels">
                                                    <option value="email_smtp">Email SMTP (Outbound)</option>
                                                    <option value="email_imap">Email IMAP (Inbound)</option>
                                                </optgroup>
                                                <optgroup label="Development & Tools">
                                                    <option value="github">GitHub API Token</option>
                                                    <option value="jira">Jira API Token</option>
                                                    <option value="linear">Linear API Token</option>
                                                </optgroup>
                                                <optgroup label="Messaging">
                                                    <option value="slack">Slack Webhook/Bot</option>
                                                    <option value="discord">Discord Webhook</option>
                                                    <option value="whatsapp">WhatsApp Business</option>
                                                </optgroup>
                                            </select>
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Label / Account Name</label>
                                            <input
                                                type="text"
                                                required
                                                value={name}
                                                onChange={(e) => setName(e.target.value)}
                                                placeholder="e.g. Sales Support SMTP"
                                                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                            />
                                        </div>
                                    </div>

                                    {(provider === "email_smtp" || provider === "email_imap") && (
                                        <div className="grid grid-cols-3 gap-4">
                                            <div className="col-span-2 space-y-1.5">
                                                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Host</label>
                                                <input
                                                    type="text"
                                                    value={host}
                                                    onChange={(e) => setHost(e.target.value)}
                                                    placeholder="smtp.gmail.com"
                                                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                                />
                                            </div>
                                            <div className="space-y-1.5">
                                                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Port</label>
                                                <input
                                                    type="text"
                                                    value={port}
                                                    onChange={(e) => setPort(e.target.value)}
                                                    placeholder="465"
                                                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                                />
                                            </div>
                                        </div>
                                    )}

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-1.5">
                                            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Username / Client ID</label>
                                            <input
                                                type="text"
                                                value={username}
                                                onChange={(e) => setUsername(e.target.value)}
                                                placeholder="user@example.com"
                                                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Secret / Password</label>
                                            <input
                                                type="password"
                                                required
                                                value={password}
                                                onChange={(e) => setPassword(e.target.value)}
                                                placeholder="••••••••••••"
                                                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                            />
                                        </div>
                                    </div>

                                    <div className="pt-2">
                                        <p className="text-[11px] text-zinc-500 mb-3">
                                            Managed secrets are leased back to OpenClaw only when the server has `EMPEROR_CLAW_MASTER_KEY`. Otherwise this record remains metadata-only and the runtime keeps the secret locally.
                                        </p>
                                        <button
                                            type="submit"
                                            disabled={isSaving}
                                            className="w-full bg-emerald-500 hover:bg-emerald-400 text-emerald-950 px-4 py-2.5 rounded-lg text-sm font-bold tracking-tight transition-all shadow-lg shadow-emerald-500/20 disabled:opacity-50"
                                        >
                                            {isSaving ? "Provisioning..." : "Securely Save credentials"}
                                        </button>
                                    </div>
                                </form>
                            </section>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
