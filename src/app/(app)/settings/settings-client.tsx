"use strict";
"use client";

import { useState } from "react";
import { KeyRound, Plus, Copy, CheckCircle2, AlertTriangle, Cable, Trash2 } from "lucide-react";

type SettingsToken = {
    id: string;
    name: string;
    scope: string;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string;
};

export default function SettingsClient({ initialTokens }: { initialTokens: SettingsToken[] }) {
    const [tokens, setTokens] = useState(initialTokens);
    const [newTokenName, setNewTokenName] = useState("");
    const [newTokenScope, setNewTokenScope] = useState<"mcp_full" | "mcp_danger">("mcp_danger");
    const [generating, setGenerating] = useState(false);
    const [activeSecret, setActiveSecret] = useState<{ id: string, name: string, secret: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const [revokingTokenId, setRevokingTokenId] = useState<string | null>(null);

    const handleGenerate = async () => {
        if (!newTokenName.trim() || generating) return;
        setGenerating(true);
        setActiveSecret(null);

        try {
            const res = await fetch("/api/settings/tokens", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: newTokenName.trim(), scope: newTokenScope }),
            });

            if (res.ok) {
                const data = await res.json();
                setTokens([data.token, ...tokens]);
                setActiveSecret({ id: data.token.id, name: data.token.name, secret: data.secret });
                setNewTokenName("");
                setNewTokenScope("mcp_danger");
            } else {
                console.error("Failed to generate token");
            }
        } catch (e) {
            console.error(e);
        } finally {
            setGenerating(false);
        }
    };

    const copyToClipboard = () => {
        if (!activeSecret) return;
        navigator.clipboard.writeText(activeSecret.secret);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleRevokeToken = async (tokenId: string) => {
        if (revokingTokenId) return;
        setRevokingTokenId(tokenId);

        try {
            const res = await fetch(`/api/settings/tokens/${tokenId}`, {
                method: "DELETE",
            });

            if (res.ok) {
                setTokens(tokens.filter((token) => token.id !== tokenId));
                if (activeSecret?.id === tokenId) {
                    setActiveSecret(null);
                }
            } else {
                console.error("Failed to revoke token");
            }
        } catch (error) {
            console.error(error);
        } finally {
            setRevokingTokenId(null);
        }
    };

    return (
        <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500">
            <div className="flex flex-col space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">Workspace Settings</h1>
                <p className="text-zinc-500 font-medium">Manage company tokens and authenticate your OpenClaw workforce.</p>
            </div>

            {/* Token Generation Pane */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                <h2 className="text-lg font-medium text-zinc-200 mb-4 flex items-center">
                    <KeyRound className="w-5 h-5 mr-2 text-indigo-400" />
                    Generate New Token
                </h2>
                <div className="flex gap-4 items-end">
                    <div className="flex-1 space-y-2">
                        <label className="text-sm font-medium text-zinc-400">Token Name</label>
                        <input
                            type="text"
                            placeholder="e.g. OpenClaw Manager CLI"
                            value={newTokenName}
                            onChange={(e) => setNewTokenName(e.target.value)}
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-md p-2.5 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                    </div>
                    <div className="w-48 space-y-2">
                        <label className="text-sm font-medium text-zinc-400">Scope</label>
                        <select
                            value={newTokenScope}
                            onChange={(e) => setNewTokenScope(e.target.value as "mcp_full" | "mcp_danger")}
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-md p-2.5 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        >
                            <option value="mcp_danger">mcp_danger</option>
                            <option value="mcp_full">mcp_full</option>
                        </select>
                    </div>
                    <button
                        onClick={handleGenerate}
                        disabled={!newTokenName.trim() || generating}
                        className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2.5 rounded-md text-sm font-medium flex items-center transition-colors disabled:opacity-50"
                    >
                        <Plus className="w-4 h-4 mr-2" />
                        {generating ? "Generating..." : "Create Token"}
                    </button>
                </div>
                <p className="mt-3 text-xs text-zinc-500">
                    `mcp_danger` is required for managed secret leasing and should only be used on a trusted runtime. `mcp_full` keeps normal MCP access but cannot lease stored secrets.
                </p>

                {activeSecret && (
                    <div className="mt-6 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                        <div className="flex items-start mb-2">
                            <AlertTriangle className="w-5 h-5 text-emerald-400 mr-2 flex-shrink-0 mt-0.5" />
                            <div>
                                <h3 className="font-medium text-emerald-400">Token Generated Successfully</h3>
                                <p className="text-sm text-emerald-500/80 mt-1">Copy this token now. You will not be able to see it again.</p>
                            </div>
                        </div>
                        <div className="mt-4 flex items-center bg-zinc-950 border border-zinc-800 rounded-md overflow-hidden">
                            <code className="px-4 py-3 flex-1 text-sm font-mono text-zinc-300 overflow-x-auto">
                                {activeSecret.secret}
                            </code>
                            <button
                                onClick={copyToClipboard}
                                className="px-4 py-3 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors border-l border-zinc-800 flex items-center"
                            >
                                {copied ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                <h2 className="text-lg font-medium text-zinc-200 mb-4 flex items-center">
                    <Cable className="w-5 h-5 mr-2 text-indigo-400" />
                    Control Plane Bootstrap
                </h2>
                <p className="text-sm text-zinc-400 mb-4">
                    Install the plugin, export a trusted `mcp_danger` company token, then add an agent and verify the local companion with the Emperor commands. This is the supported path for validating runtime registration, websocket reachability, threads, heartbeats, and checkpoints.
                </p>
                <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 space-y-3">
                    <code className="block text-sm font-mono text-zinc-300 whitespace-pre-wrap">
                        openclaw plugins install clawhub:@malecu/emperor-claw-os-plugin
                    </code>
                    <code className="block text-sm font-mono text-zinc-300 whitespace-pre-wrap">
                        EMPEROR_CLAW_API_TOKEN=your_token_here openclaw emperor add-agent --name "Operator One" --profile operator
                    </code>
                    <code className="block text-sm font-mono text-zinc-300 whitespace-pre-wrap">
                        EMPEROR_CLAW_API_TOKEN=your_token_here openclaw emperor doctor
                    </code>
                    <code className="block text-sm font-mono text-zinc-300 whitespace-pre-wrap">
                        EMPEROR_CLAW_API_TOKEN=your_token_here openclaw emperor status
                    </code>
                </div>
                <p className="text-xs text-zinc-500 mt-4">
                    Managed secret leasing is enabled when the server is configured with `EMPEROR_CLAW_MASTER_KEY`. Otherwise, Emperor stores integration metadata and the runtime keeps unsupported secrets locally. The bootstrap command writes a safe companion directory under your local OpenClaw home without overwriting your main OpenClaw config.
                </p>
            </div>

            {/* Token List */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
                <div className="p-6 border-b border-zinc-800">
                    <h2 className="text-lg font-medium text-zinc-200">Active Tokens</h2>
                </div>
                <div className="divide-y divide-zinc-800/60">
                    {tokens.length === 0 ? (
                        <div className="p-8 text-center text-zinc-500 text-sm">
                            No API tokens active. Generate one above to connect OpenClaw.
                        </div>
                    ) : (
                        tokens.map((token) => (
                            <div key={token.id} className="p-6 flex items-center justify-between hover:bg-zinc-800/20 transition-colors">
                                <div>
                                    <div className="flex items-center gap-3 mb-1">
                                        <h3 className="font-medium text-zinc-200">{token.name}</h3>
                                        <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded border bg-indigo-500/10 text-indigo-400 border-indigo-500/20">
                                            {token.scope}
                                        </span>
                                    </div>
                                    <p className="text-xs text-zinc-500 font-mono">
                                        ID: {token.id} • Created: {new Date(token.createdAt).toLocaleDateString()} • Expires: {new Date(token.expiresAt).toLocaleDateString()}
                                    </p>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="text-right">
                                        <p className="text-xs font-medium text-zinc-400">Last Used</p>
                                        <p className="text-sm text-zinc-500">
                                            {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "Never"}
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => handleRevokeToken(token.id)}
                                        disabled={revokingTokenId === token.id}
                                        className="inline-flex items-center rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-300 transition-colors hover:bg-rose-500/20 disabled:opacity-50"
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        {revokingTokenId === token.id ? "Revoking..." : "Revoke"}
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}

