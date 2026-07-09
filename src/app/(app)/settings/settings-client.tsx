"use client";

import { useState } from "react";
import { AlertTriangle, Cable, CheckCircle2, Copy, KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type SettingsToken = {
    id: string;
    name: string;
    scope: string;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string;
};

type SettingsTab = "connections" | "tokens" | "advanced";
type TokenScope = "mcp_full" | "mcp_danger";

const runtimeCards = [
    {
        title: "Hermes agents",
        body: "Use one Hermes profile and one bridge service per Emperor agent. Best when your team runs Hermes on local machines or Raspberry Pi-style workers.",
        href: "/docs/v1.1/hermes-runtime",
        cta: "Open Hermes guide",
    },
    {
        title: "OpenClaw agents",
        body: "Use the OpenClaw plugin when you want the packaged local workspace and doctor/repair commands.",
        href: "/docs/v1.1/openclaw-agents",
        cta: "Open OpenClaw guide",
    },
];

function tokenScopeLabel(scope: string) {
    return scope === "mcp_danger" ? "Secret leasing" : "Agent access";
}

function tokenScopeHelp(scope: TokenScope) {
    return scope === "mcp_danger"
        ? "For trusted local runtimes that need managed secret leasing. Use sparingly."
        : "Default token for connected agents, bridges, and normal runtime access.";
}

export default function SettingsClient({ initialTokens }: { initialTokens: SettingsToken[] }) {
    const [tokens, setTokens] = useState(initialTokens);
    const [newTokenName, setNewTokenName] = useState("");
    const [newTokenScope, setNewTokenScope] = useState<TokenScope>("mcp_full");
    const [activeTab, setActiveTab] = useState<SettingsTab>("connections");
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
                setNewTokenScope("mcp_full");
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
        void navigator.clipboard.writeText(activeSecret.secret);
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
                if (activeSecret?.id === tokenId) setActiveSecret(null);
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
        <div className="mx-auto max-w-6xl space-y-6 animate-in fade-in duration-500">
            <header className="emperor-panel rounded-[2rem] p-6">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-cyan-300">
                            <ShieldCheck className="h-4 w-4" /> Workspace control
                        </div>
                        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">Workspace & Access</h1>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
                            Connect agent runtimes, manage access tokens, and keep dangerous setup details behind an advanced section.
                        </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:min-w-80">
                        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                            <div className="text-xs uppercase tracking-wider text-zinc-500">Active tokens</div>
                            <div className="mt-1 text-2xl font-semibold text-white">{tokens.length}</div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                            <div className="text-xs uppercase tracking-wider text-zinc-500">Runtimes</div>
                            <div className="mt-1 text-2xl font-semibold text-white">2</div>
                        </div>
                    </div>
                </div>
            </header>

            <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-zinc-950/60 p-2">
                {([
                    ["connections", "Agent Connections"],
                    ["tokens", "Access Tokens"],
                    ["advanced", "Advanced"],
                ] as const).map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        onClick={() => setActiveTab(id)}
                        className={cn(
                            "cursor-pointer rounded-xl px-4 py-2 text-sm font-medium transition-colors",
                            activeTab === id ? "bg-cyan-400/10 text-cyan-100 ring-1 ring-cyan-400/25" : "text-zinc-400 hover:bg-white/[0.045] hover:text-zinc-100"
                        )}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {activeTab === "connections" && (
                <section className="grid gap-4 lg:grid-cols-2">
                    {runtimeCards.map((runtime) => (
                        <article key={runtime.title} className="emperor-panel rounded-3xl p-6">
                            <div className="flex items-center gap-3">
                                <div className="grid h-11 w-11 place-items-center rounded-2xl border border-cyan-400/25 bg-cyan-400/10">
                                    <Cable className="h-5 w-5 text-cyan-300" />
                                </div>
                                <h2 className="text-xl font-semibold text-white">{runtime.title}</h2>
                            </div>
                            <p className="mt-4 text-sm leading-6 text-zinc-400">{runtime.body}</p>
                            <a href={runtime.href} className="mt-5 inline-flex text-sm font-semibold text-cyan-300 hover:text-cyan-200">
                                {runtime.cta}
                            </a>
                        </article>
                    ))}
                    <article className="rounded-3xl border border-amber-500/20 bg-amber-500/[0.06] p-6 lg:col-span-2">
                        <h2 className="text-sm font-semibold text-amber-100">Operator rule</h2>
                        <p className="mt-2 text-sm leading-6 text-amber-100/75">
                            Create the agent profile in Emperor first, then connect exactly one local runtime profile or workspace to that agent. The runtime can be Hermes or OpenClaw; Emperor should stay runtime-neutral.
                        </p>
                    </article>
                </section>
            )}

            {activeTab === "tokens" && (
                <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(420px,1.2fr)]">
                    <div className="emperor-panel rounded-3xl p-6">
                        <h2 className="mb-4 flex items-center text-lg font-semibold text-zinc-100">
                            <KeyRound className="mr-2 h-5 w-5 text-cyan-300" /> Create access token
                        </h2>
                        <div className="space-y-4">
                            <label className="block space-y-2">
                                <span className="text-sm font-medium text-zinc-300">Token name</span>
                                <Input
                                    type="text"
                                    placeholder="e.g. Pi bridge, Growth agent, QA runtime"
                                    value={newTokenName}
                                    onChange={(event) => setNewTokenName(event.target.value)}
                                />
                            </label>
                            <label className="block space-y-2">
                                <span className="text-sm font-medium text-zinc-300">Access level</span>
                                <select
                                    value={newTokenScope}
                                    onChange={(event) => setNewTokenScope(event.target.value as TokenScope)}
                                    className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.035] px-3 text-sm text-zinc-100 outline-none focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20"
                                >
                                    <option value="mcp_full">Agent access</option>
                                    <option value="mcp_danger">Secret leasing</option>
                                </select>
                                <p className="text-xs leading-5 text-zinc-500">{tokenScopeHelp(newTokenScope)}</p>
                            </label>
                            <Button onClick={handleGenerate} disabled={!newTokenName.trim() || generating} className="w-full">
                                <Plus className="h-4 w-4" /> {generating ? "Creating..." : "Create token"}
                            </Button>
                        </div>

                        {activeSecret && (
                            <div className="mt-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
                                <div className="flex items-start gap-3">
                                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
                                    <div>
                                        <h3 className="font-medium text-emerald-200">Token created</h3>
                                        <p className="mt-1 text-sm text-emerald-100/75">Copy it now. Emperor will not show this secret again.</p>
                                    </div>
                                </div>
                                <div className="mt-4 flex overflow-hidden rounded-xl border border-white/10 bg-black/35">
                                    <code className="flex-1 overflow-x-auto px-4 py-3 font-mono text-sm text-zinc-300">{activeSecret.secret}</code>
                                    <button onClick={copyToClipboard} className="cursor-pointer border-l border-white/10 px-4 text-zinc-400 transition-colors hover:bg-white/[0.045] hover:text-white">
                                        {copied ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="overflow-hidden rounded-3xl border border-white/10 bg-zinc-950/70">
                        <div className="border-b border-white/10 p-5">
                            <h2 className="text-lg font-semibold text-zinc-100">Active tokens</h2>
                            <p className="mt-1 text-sm text-zinc-500">Revoke anything that is no longer attached to a real runtime.</p>
                        </div>
                        <div className="divide-y divide-white/10">
                            {tokens.length === 0 ? (
                                <div className="p-8 text-center text-sm text-zinc-500">No access tokens active. Create one to connect an agent runtime.</div>
                            ) : (
                                tokens.map((token) => (
                                    <div key={token.id} className="flex flex-col gap-4 p-5 transition-colors hover:bg-white/[0.025] sm:flex-row sm:items-center sm:justify-between">
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h3 className="font-medium text-zinc-100">{token.name}</h3>
                                                <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-200">
                                                    {tokenScopeLabel(token.scope)}
                                                </span>
                                            </div>
                                            <p className="mt-1 font-mono text-xs text-zinc-500">
                                                ID: {token.id} · Created: {new Date(token.createdAt).toLocaleDateString()} · Expires: {new Date(token.expiresAt).toLocaleDateString()}
                                            </p>
                                            <p className="mt-1 text-xs text-zinc-500">Last used: {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "Never"}</p>
                                        </div>
                                        <Button variant="destructive" size="sm" onClick={() => handleRevokeToken(token.id)} disabled={revokingTokenId === token.id}>
                                            <Trash2 className="h-4 w-4" /> {revokingTokenId === token.id ? "Revoking..." : "Revoke"}
                                        </Button>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </section>
            )}

            {activeTab === "advanced" && (
                <section className="space-y-4">
                    <div className="emperor-panel rounded-3xl p-6">
                        <h2 className="flex items-center text-lg font-semibold text-zinc-100">
                            <Cable className="mr-2 h-5 w-5 text-cyan-300" /> Advanced runtime setup
                        </h2>
                        <p className="mt-2 text-sm leading-6 text-zinc-400">
                            Use this when manually validating a local companion, bridge, heartbeats, checkpoints, or token permissions. Most operators only need the runtime guides above.
                        </p>
                        <details className="mt-5 rounded-2xl border border-white/10 bg-black/25 p-4">
                            <summary className="cursor-pointer text-sm font-semibold text-zinc-200">Show OpenClaw plugin commands</summary>
                            <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-zinc-950 p-4">
                                <code className="block whitespace-pre-wrap font-mono text-sm text-zinc-300">openclaw plugins install clawhub:@malecu/emperor-claw-os-plugin</code>
                                <code className="block whitespace-pre-wrap font-mono text-sm text-zinc-300">openclaw emperor add-agent --agent-name &quot;Operator One&quot; --local-brain-agent-id operator-one --token &quot;your_token_here&quot; --profile operator</code>
                                <code className="block whitespace-pre-wrap font-mono text-sm text-zinc-300">EMPEROR_CLAW_API_TOKEN=your_token_here openclaw emperor doctor</code>
                                <code className="block whitespace-pre-wrap font-mono text-sm text-zinc-300">EMPEROR_CLAW_API_TOKEN=your_token_here openclaw emperor status</code>
                            </div>
                        </details>
                        <details className="mt-3 rounded-2xl border border-white/10 bg-black/25 p-4">
                            <summary className="cursor-pointer text-sm font-semibold text-zinc-200">Show token scope internals</summary>
                            <p className="mt-3 text-sm leading-6 text-zinc-400">
                                Agent access maps to the normal MCP access scope. Secret leasing maps to the privileged scope required for managed secret leases and should only be used on trusted runtimes.
                            </p>
                        </details>
                    </div>
                </section>
            )}
        </div>
    );
}
