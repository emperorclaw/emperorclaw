"use strict";
"use client";

import { useState } from "react";
import { KeyRound, Plus, Copy, CheckCircle2, AlertTriangle, Save, ScrollText, Cable } from "lucide-react";

type SettingsToken = {
    id: string;
    name: string;
    scope: string;
    createdAt: string;
    lastUsedAt: string | null;
};

export default function SettingsClient({ initialTokens, initialContextNotes }: { initialTokens: SettingsToken[], initialContextNotes: string }) {
    const [tokens, setTokens] = useState(initialTokens);
    const [contextNotes, setContextNotes] = useState(initialContextNotes);
    const [isSavingNotes, setIsSavingNotes] = useState(false);
    const [notesSaved, setNotesSaved] = useState(false);
    const [newTokenName, setNewTokenName] = useState("");
    const [generating, setGenerating] = useState(false);
    const [activeSecret, setActiveSecret] = useState<{ id: string, name: string, secret: string } | null>(null);
    const [copied, setCopied] = useState(false);

    const handleGenerate = async () => {
        if (!newTokenName.trim() || generating) return;
        setGenerating(true);
        setActiveSecret(null);

        try {
            const res = await fetch("/api/settings/tokens", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: newTokenName.trim() }),
            });

            if (res.ok) {
                const data = await res.json();
                setTokens([data.token, ...tokens]);
                setActiveSecret({ id: data.token.id, name: data.token.name, secret: data.secret });
                setNewTokenName("");
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

    const handleSaveContext = async () => {
        setIsSavingNotes(true);
        try {
            const res = await fetch("/api/settings/company", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contextNotes }),
            });
            if (res.ok) {
                setNotesSaved(true);
                setTimeout(() => setNotesSaved(false), 3000);
            }
        } catch (error) {
            console.error(error);
        } finally {
            setIsSavingNotes(false);
        }
    };

    return (
        <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500">
            <div className="flex flex-col space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">Workspace Settings</h1>
                <p className="text-zinc-500 font-medium">Manage your company mission and authenticate your OpenClaw workforce.</p>
            </div>

            {/* Company Mission Pane */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-lg font-medium text-zinc-200 flex items-center">
                        <ScrollText className="w-5 h-5 mr-2 text-indigo-400" />
                        Global Company Context
                    </h2>
                    <button
                        onClick={handleSaveContext}
                        disabled={isSavingNotes || contextNotes === initialContextNotes && !notesSaved}
                        className="bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1.5 rounded-md text-sm font-medium flex items-center transition-colors disabled:opacity-50"
                    >
                        {notesSaved ? <CheckCircle2 className="w-4 h-4 mr-2 text-emerald-400" /> : <Save className="w-4 h-4 mr-2" />}
                        {isSavingNotes ? "Saving..." : notesSaved ? "Saved" : "Save Changes"}
                    </button>
                </div>
                <div className="space-y-2">
                    <p className="text-sm text-zinc-400 mb-2">Define the overarching mission or &quot;System Prompt&quot; for your company. All OpenClaw agents pull this context automatically, regardless of customer assignments.</p>
                    <textarea
                        value={contextNotes}
                        onChange={(e) => setContextNotes(e.target.value)}
                        placeholder="e.g. We are an outbound lead generation agency. Our tone is always professional and aggressive..."
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 min-h-[120px] resize-y"
                    />
                </div>
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
                    <button
                        onClick={handleGenerate}
                        disabled={!newTokenName.trim() || generating}
                        className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2.5 rounded-md text-sm font-medium flex items-center transition-colors disabled:opacity-50"
                    >
                        <Plus className="w-4 h-4 mr-2" />
                        {generating ? "Generating..." : "Create Token"}
                    </button>
                </div>

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
                    Install the skill, export your company token, then use the local companion bootstrap and doctor commands before launching the bridge. This is the supported path for validating runtime registration, websocket reachability, threads, heartbeats, and checkpoints.
                </p>
                <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 space-y-3">
                    <code className="block text-sm font-mono text-zinc-300 whitespace-pre-wrap">
                        openclaw install https://emperorclaw.malecu.eu/api/skills/registry/emperor-claw-os
                    </code>
                    <code className="block text-sm font-mono text-zinc-300 whitespace-pre-wrap">
                        EMPEROR_CLAW_API_TOKEN=your_token_here npm run control-plane:bootstrap
                    </code>
                    <code className="block text-sm font-mono text-zinc-300 whitespace-pre-wrap">
                        EMPEROR_CLAW_API_TOKEN=your_token_here npm run control-plane:doctor
                    </code>
                    <code className="block text-sm font-mono text-zinc-300 whitespace-pre-wrap">
                        EMPEROR_CLAW_API_TOKEN=your_token_here node clawhub/emperor-claw-os/examples/bridge.js
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
                                        ID: {token.id} • Created: {new Date(token.createdAt).toLocaleDateString()}
                                    </p>
                                </div>
                                <div className="text-right">
                                    <p className="text-xs font-medium text-zinc-400">Last Used</p>
                                    <p className="text-sm text-zinc-500">
                                        {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "Never"}
                                    </p>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
