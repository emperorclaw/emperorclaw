"use client";

import { useEffect, useState } from "react";
import { IconAlertTriangle, IconArrowRight, IconPlugConnected, IconCircleCheck, IconCopy, IconKey, IconPlus, IconSettings, IconTrash, IconUsers, IconArrowUp } from "@tabler/icons-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { UpdateSettingsTab } from "@/components/update-settings-tab";
import MembersClient from "./members/members-client";

type SettingsToken = {
    id: string;
    name: string;
    scope: string;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string;
};

type SettingsTab = "connections" | "tokens" | "updates" | "advanced" | "instance" | "members";

type Member = {
    id: string;
    email: string;
    companyRole: string;
    instanceRole: string;
    joinedAt: string | null;
};
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

export default function SettingsClient({
    initialTokens,
    companyRole,
    instanceRole,
    currentUserId,
    currentUserRole,
    companyId,
    initialMembers,
    agents,
    customersData,
}: {
    initialTokens: SettingsToken[];
    companyRole: string;
    instanceRole: string;
    currentUserId?: string;
    currentUserRole?: string;
    companyId?: string;
    initialMembers?: Member[];
    agents?: { id: string; name: string }[];
    customersData?: { id: string; name: string }[];
}) {
    const searchParams = useSearchParams();
    const [tokens, setTokens] = useState(initialTokens);
    const [newTokenName, setNewTokenName] = useState("");
    const [newTokenScope, setNewTokenScope] = useState<TokenScope>("mcp_full");
    const [activeTab, setActiveTab] = useState<SettingsTab>(
        (searchParams.get("tab") as SettingsTab) || "connections"
    );
    const [generating, setGenerating] = useState(false);
    const [activeSecret, setActiveSecret] = useState<{ id: string, name: string, secret: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const [revokingTokenId, setRevokingTokenId] = useState<string | null>(null);
    const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);

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
                toast.success("API key created.");
            } else {
                console.error("Failed to generate token");
                toast.error("Failed to create API key.");
            }
        } catch (e) {
            console.error(e);
            toast.error("Failed to create API key.");
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

        // Require confirmation for revoke (irreversible)
        if (confirmingRevokeId !== tokenId) {
            setConfirmingRevokeId(tokenId);
            setTimeout(() => setConfirmingRevokeId(null), 4000);
            return;
        }
        setConfirmingRevokeId(null);

        setRevokingTokenId(tokenId);

        try {
            const res = await fetch(`/api/settings/tokens/${tokenId}`, {
                method: "DELETE",
            });

            if (res.ok) {
                setTokens(tokens.filter((token) => token.id !== tokenId));
                if (activeSecret?.id === tokenId) setActiveSecret(null);
                toast.success("API key revoked.");
            } else {
                console.error("Failed to revoke token");
                toast.error("Failed to revoke API key.");
            }
        } catch (error) {
            console.error(error);
            toast.error("Failed to revoke API key.");
        } finally {
            setRevokingTokenId(null);
        }
    };

    return (
        <div className="mx-auto max-w-[1800px] space-y-6 animate-in fade-in duration-500">
            <PageHeader
                eyebrow="Settings"
                title="Workspace & Access"
                description="Connect agent runtimes, manage access tokens, and keep dangerous setup details behind an advanced section."
                actions={
                    <div className="grid grid-cols-2 gap-2 sm:gap-3 w-full sm:min-w-80">
                        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-3 sm:p-4">
                            <div className="text-[10px] sm:text-xs uppercase tracking-wider text-zinc-500">Active tokens</div>
                            <div className="mt-1 text-xl sm:text-2xl font-semibold text-white">{tokens.length}</div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-3 sm:p-4">
                            <div className="text-[10px] sm:text-xs uppercase tracking-wider text-zinc-500">Runtimes</div>
                            <div className="mt-1 text-xl sm:text-2xl font-semibold text-white">2</div>
                        </div>
                    </div>
                }
            />

            <div className="flex gap-1.5 sm:gap-2 overflow-x-auto rounded-2xl border border-white/10 bg-zinc-950/60 p-1.5 sm:p-2">
                {([
                    ["connections", "Agent Connections"],
                    ["tokens", "Access Tokens"],
                    ["updates", "Updates"],
                    ["advanced", "Advanced"],
                    ...(instanceRole === "instance_admin" ? [["instance", "Instance"] as const] : []),
                    ...(instanceRole === "instance_admin" || companyRole === "owner" || companyRole === "admin" ? [["members", "Members"] as const] : []),
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
                <section className="grid gap-3 sm:gap-4 lg:grid-cols-2">
                    {runtimeCards.map((runtime) => (
                        <article key={runtime.title} className="emperor-panel rounded-2xl sm:rounded-3xl p-4 sm:p-6">
                            <div className="flex items-center gap-3">
                                <div className="grid h-11 w-11 place-items-center rounded-2xl border border-cyan-400/25 bg-cyan-400/10">
                                    <IconPlugConnected className="h-5 w-5 text-cyan-300" />
                                </div>
                                <h2 className="text-xl font-semibold text-white">{runtime.title}</h2>
                            </div>
                            <p className="mt-4 text-sm leading-6 text-zinc-400">{runtime.body}</p>
                            <a href={runtime.href} className="mt-5 inline-flex text-sm font-semibold text-cyan-300 hover:text-cyan-200">
                                {runtime.cta}
                            </a>
                        </article>
                    ))}
                    <article className="rounded-2xl sm:rounded-3xl border border-amber-500/20 bg-amber-500/[0.06] p-4 sm:p-6 lg:col-span-2">
                        <h2 className="text-sm font-semibold text-amber-100">Operator rule</h2>
                        <p className="mt-2 text-sm leading-6 text-amber-100/75">
                            Create the agent profile in Emperor first, then connect exactly one local runtime profile or workspace to that agent. The runtime can be Hermes or OpenClaw; Emperor should stay runtime-neutral.
                        </p>
                    </article>
                    <article className="rounded-2xl sm:rounded-3xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4 sm:p-6 lg:col-span-2">
                        <div className="flex items-center gap-3">
                            <span className="text-2xl">🤖</span>
                            <h2 className="text-lg font-semibold text-emerald-100">Quick Setup — Let your own LLM configure it</h2>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-emerald-100/75">
                            Don&apos;t want to configure everything manually? Copy a prompt below, paste it into <strong>Claude, ChatGPT, Codex, or any LLM</strong>, and it will walk you through the entire setup — installing the runtime, configuring the bridge, writing bootstrap files, and tailoring the agent to your role.
                        </p>
                        <div className="mt-4 grid gap-4 sm:grid-cols-2">
                            {/* Hermes prompt */}
                            <div className="rounded-xl border border-emerald-500/30 bg-black/30 overflow-hidden">
                                <div className="flex items-center justify-between px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20">
                                    <span className="text-xs font-bold uppercase tracking-wider text-emerald-200">Hermes agent</span>
                                    <CopyPromptButton text={`I need to connect a Hermes agent to Emperor Claw, an open-source AI workforce control plane.

Repo & docs: https://github.com/emperorclaw/emperorclaw
Bridge installer (Linux/Mac): https://emperorclaw.malecu.eu/install.sh
Bridge installer (Windows): https://emperorclaw.malecu.eu/install.ps1

My agent role is: [DESCRIBE YOUR ROLE HERE]

Please read the relevant docs and guide me step by step through:
1. Installing Hermes runtime if I don't have it
2. Setting up the Emperor Hermes bridge and plugin
3. Creating the agent profile, SOUL, toolsets, and operating doctrine for this role: [ROLE]
4. Creating a systemd service (or equivalent) to keep it running
5. Connecting to my Emperor Claw instance (I'll give you the URL and token)

Ask me for any info you need along the way.`} />
                                </div>
                                <pre className="p-4 text-xs text-emerald-100/80 whitespace-pre-wrap max-h-[260px] overflow-y-auto font-mono leading-relaxed select-all">{`I need to connect a Hermes agent to Emperor Claw, an open-source AI workforce control plane.

Repo & docs: https://github.com/emperorclaw/emperorclaw
Bridge installer (Linux/Mac): https://emperorclaw.malecu.eu/install.sh
Bridge installer (Windows): https://emperorclaw.malecu.eu/install.ps1

My agent role is: [DESCRIBE YOUR ROLE HERE]

Please read the relevant docs and guide me step by step through:
1. Installing Hermes runtime if I don't have it
2. Setting up the Emperor Hermes bridge and plugin
3. Creating the agent profile, SOUL, toolsets, and operating doctrine for this role: [ROLE]
4. Creating a systemd service (or equivalent) to keep it running
5. Connecting to my Emperor Claw instance (I'll give you the URL and token)

Ask me for any info you need along the way.`}</pre>
                            </div>

                            {/* OpenClaw prompt */}
                            <div className="rounded-xl border border-emerald-500/30 bg-black/30 overflow-hidden">
                                <div className="flex items-center justify-between px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20">
                                    <span className="text-xs font-bold uppercase tracking-wider text-emerald-200">OpenClaw agent</span>
                                    <CopyPromptButton text={`I need to configure an OpenClaw agent connected to Emperor Claw, an open-source AI workforce control plane.

Repo & docs: https://github.com/emperorclaw/emperorclaw
OpenClaw agent docs: see docs/v1.1/openclaw-agents.md in the repo
Operating pipeline: see docs/v1.1/emperor-operating-pipeline.md in the repo

My agent role is: [DESCRIBE YOUR ROLE HERE]

Please read the relevant docs and create the bootstrap files for this role: [ROLE]
Generate these files with content tailored to the role:
- AGENTS.md (stable operating rules, session startup, red lines)
- SOUL.md (persona, tone, voice)
- BOOTSTRAP.md (startup reading order)
- IDENTITY.md (name, role, emoji)
- USER.md (operator preferences, timezone defaults)
- TOOLS.md (local machine knowledge)
- HEARTBEAT.md (periodic review checklist)

Follow the Emperor doctrine: keep files short, put durable rules under "## Session Startup" and "## Red Lines", keep persona in SOUL.md, never mix volatile state with permanent doctrine.

Also give me the plugin install command and bridge config needed to connect to my Emperor Claw instance (I'll give you the URL and token).

Walk me through step by step.`} />
                                </div>
                                <pre className="p-4 text-xs text-emerald-100/80 whitespace-pre-wrap max-h-[260px] overflow-y-auto font-mono leading-relaxed select-all">{`I need to configure an OpenClaw agent connected to Emperor Claw, an open-source AI workforce control plane.

Repo & docs: https://github.com/emperorclaw/emperorclaw
OpenClaw agent docs: see docs/v1.1/openclaw-agents.md in the repo
Operating pipeline: see docs/v1.1/emperor-operating-pipeline.md in the repo

My agent role is: [DESCRIBE YOUR ROLE HERE]

Please read the relevant docs and create the bootstrap files for this role: [ROLE]
Generate these files with content tailored to the role:
- AGENTS.md (stable operating rules, session startup, red lines)
- SOUL.md (persona, tone, voice)
- BOOTSTRAP.md (startup reading order)
- IDENTITY.md (name, role, emoji)
- USER.md (operator preferences, timezone defaults)
- TOOLS.md (local machine knowledge)
- HEARTBEAT.md (periodic review checklist)

Follow the Emperor doctrine: keep files short, put durable rules under "## Session Startup" and "## Red Lines", keep persona in SOUL.md, never mix volatile state with permanent doctrine.

Also give me the plugin install command and bridge config needed to connect to my Emperor Claw instance (I'll give you the URL and token).

Walk me through step by step.`}</pre>
                            </div>
                        </div>
                        <p className="mt-3 text-xs text-emerald-100/60">
                            Replace <code className="bg-emerald-500/15 px-1 rounded text-emerald-200">[DESCRIBE YOUR ROLE HERE]</code> with your agent&apos;s actual role — e.g. &quot;SEO Specialist&quot;, &quot;Lead Generation Agent&quot;, &quot;Technical Implementation Agent&quot;. The more specific you are, the better the result.
                        </p>
                    </article>
                </section>
            )}

            {activeTab === "tokens" && (
                <section className="grid gap-4 sm:gap-6 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,1.2fr)]">
                    <div className="emperor-panel rounded-2xl sm:rounded-3xl p-4 sm:p-6">
                        <h2 className="mb-4 flex items-center text-lg font-semibold text-zinc-100">
                            <IconKey className="mr-2 h-5 w-5 text-cyan-300" /> Create access token
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
                                <IconPlus className="h-4 w-4" /> {generating ? "Creating..." : "Create token"}
                            </Button>
                        </div>

                        {activeSecret && (
                            <div className="mt-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
                                <div className="flex items-start gap-3">
                                    <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
                                    <div>
                                        <h3 className="font-medium text-emerald-200">Token created</h3>
                                        <p className="mt-1 text-sm text-emerald-100/75">Copy it now. Emperor will not show this secret again.</p>
                                    </div>
                                </div>
                                <div className="mt-4 flex overflow-hidden rounded-xl border border-white/10 bg-black/35">
                                    <code className="flex-1 overflow-x-auto px-4 py-3 font-mono text-sm text-zinc-300">{activeSecret.secret}</code>
                                    <button onClick={copyToClipboard} className="cursor-pointer border-l border-white/10 px-4 text-zinc-400 transition-colors hover:bg-white/[0.045] hover:text-white">
                                        {copied ? <IconCircleCheck className="h-4 w-4 text-emerald-300" /> : <IconCopy className="h-4 w-4" />}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="overflow-hidden rounded-2xl sm:rounded-3xl border border-white/10 bg-zinc-950/70">
                        <div className="border-b border-white/10 p-4 sm:p-5">
                            <h2 className="text-lg font-semibold text-zinc-100">Active tokens</h2>
                            <p className="mt-1 text-sm text-zinc-500">Revoke anything that is no longer attached to a real runtime.</p>
                        </div>
                        <div className="divide-y divide-white/10">
                            {tokens.length === 0 ? (
                                <div className="p-8 text-center text-sm text-zinc-500">No access tokens active. Create one to connect an agent runtime.</div>
                            ) : (
                                tokens.map((token) => (
                                    <div key={token.id} className="flex flex-col gap-3 sm:gap-4 p-4 sm:p-5 transition-colors hover:bg-white/[0.025] sm:flex-row sm:items-center sm:justify-between">
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
                                            <IconTrash className="h-4 w-4" /> {revokingTokenId === token.id ? "Revoking..." : confirmingRevokeId === token.id ? "Click again to confirm" : "Revoke"}
                                        </Button>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </section>
            )}

            {activeTab === "updates" && <UpdateSettingsTab />}

            {activeTab === "advanced" && (
                <section className="space-y-4">
                    <div className="emperor-panel rounded-2xl sm:rounded-3xl p-4 sm:p-6">
                        <h2 className="flex items-center text-lg font-semibold text-zinc-100">
                            <IconPlugConnected className="mr-2 h-5 w-5 text-cyan-300" /> Advanced runtime setup
                        </h2>
                        <p className="mt-2 text-sm leading-6 text-zinc-400">
                            Use this when manually validating a local companion, bridge, heartbeats, checkpoints, or token permissions. Most operators only need the runtime guides above.
                        </p>
                        <details className="mt-5 rounded-2xl border border-white/10 bg-black/25 p-4">
                            <summary className="cursor-pointer text-sm font-semibold text-zinc-200">Show OpenClaw plugin commands</summary>
                            <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-zinc-950 p-4">
                                <code className="block whitespace-pre-wrap font-mono text-sm text-zinc-300">openclaw plugins install clawhub:emperor-claw-os-plugin</code>
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

            {activeTab === "instance" && instanceRole === "instance_admin" && (
                <InstanceSettingsTab />
            )}

            {activeTab === "members" && currentUserId && currentUserRole && companyId && initialMembers && agents && customersData && (
                <MembersClient
                    currentUserId={currentUserId}
                    currentUserRole={currentUserRole}
                    companyId={companyId}
                    initialMembers={initialMembers}
                    agents={agents}
                    customersData={customersData}
                />
            )}
        </div>
    );
}

function InstanceSettingsTab() {
    const [registrationMode, setRegistrationMode] = useState<string | null>(null);
    const [instanceName, setInstanceName] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [savingName, setSavingName] = useState(false);

    // Load current settings
    useEffect(() => {
        if (loaded) return;
        setLoaded(true);
        fetch("/api/instance/settings")
            .then((r) => r.json())
            .then((data) => {
                setRegistrationMode(data.settings?.registration_mode ?? "invite-only");
                setInstanceName(data.settings?.instance_name ?? "");
            })
            .catch(() => setRegistrationMode("invite-only"));
    }, [loaded]);

    const handleToggle = async () => {
        if (saving || !registrationMode) return;
        const newMode = registrationMode === "invite-only" ? "open" : "invite-only";
        setSaving(true);
        try {
            const res = await fetch("/api/instance/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ settings: { registration_mode: newMode } }),
            });
            if (res.ok) {
                setRegistrationMode(newMode);
                toast.success(`Registration is now ${newMode === "open" ? "open" : "invite-only"}.`);
            } else {
                toast.error("Failed to update registration mode.");
            }
        } catch {
            toast.error("Failed to update registration mode.");
        } finally {
            setSaving(false);
        }
    };

    const handleSaveName = async () => {
        if (savingName) return;
        setSavingName(true);
        try {
            const res = await fetch("/api/instance/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ settings: { instance_name: instanceName } }),
            });
            if (res.ok) {
                toast.success("Instance name updated.");
            } else {
                toast.error("Failed to update instance name.");
            }
        } catch {
            toast.error("Failed to update instance name.");
        } finally {
            setSavingName(false);
        }
    };

    return (
        <section className="space-y-4">
            <div className="emperor-panel rounded-2xl sm:rounded-3xl p-4 sm:p-6">
                <h2 className="flex items-center text-lg font-semibold text-zinc-100">
                    <IconSettings className="mr-2 h-5 w-5 text-cyan-300" /> Instance configuration
                </h2>
                <p className="mt-2 text-sm leading-6 text-zinc-400">
                    These settings apply to the entire self-hosted instance. Only the instance administrator can change them.
                </p>

                <div className="mt-6 space-y-4">
                    <div className="flex items-center justify-between rounded-xl border border-white/10 bg-black/25 p-4">
                        <div>
                            <h3 className="font-medium text-zinc-100">Registration mode</h3>
                            <p className="mt-1 text-sm text-zinc-400">
                                {registrationMode === "open"
                                    ? "Anyone can sign up and join this instance as a member."
                                    : "Only invited users can create an account."}
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleToggle}
                            disabled={saving || !registrationMode}
                            className={cn(
                                "min-w-[100px]",
                                registrationMode === "open" && "border-emerald-500/30 text-emerald-300"
                            )}
                        >
                            {saving ? "Saving..." : registrationMode === "open" ? "Open" : "Invite-only"}
                        </Button>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-black/25 p-4">
                        <h3 className="font-medium text-zinc-100">Instance name</h3>
                        <p className="mt-1 text-sm text-zinc-400">Display name shown in emails and page titles.</p>
                        <div className="mt-3 flex gap-2">
                            <Input
                                type="text"
                                placeholder="My Emperor Claw Instance"
                                value={instanceName}
                                onChange={(e) => setInstanceName(e.target.value)}
                                className="flex-1"
                            />
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleSaveName}
                                disabled={savingName}
                            >
                                {savingName ? "Saving..." : "Save"}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}

function CopyPromptButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        toast.success("Prompt copied to clipboard");
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <button
            type="button"
            onClick={handleCopy}
            className="cursor-pointer rounded-lg border border-emerald-500/30 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/15 transition-colors flex items-center gap-1.5"
        >
            {copied ? <IconCircleCheck className="h-3.5 w-3.5" /> : <IconCopy className="h-3.5 w-3.5" />}
            {copied ? "Copied!" : "Copy prompt"}
        </button>
    );
}
