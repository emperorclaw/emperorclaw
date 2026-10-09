"use client";

import { useEffect, useState } from "react";
import { IconAlertTriangle, IconArrowRight, IconPlugConnected, IconCircleCheck, IconCopy, IconKey, IconPlus, IconSettings, IconTrash, IconUsers } from "@tabler/icons-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { UpdateSettingsTab } from "@/components/update-settings-tab";
import MembersClient from "./members/members-client";
import { NotificationSettingsTab } from "./notification-settings-tab";
import { RoutineSettingsTab } from "./routine-settings-tab";
import { DisplaysTab } from "./displays-tab";

type SettingsToken = {
    id: string;
    name: string;
    scope: string;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string;
    callbackUrlHint?: string | null;
    includePrivateChats?: boolean;
};

import { resolveSettingsTab, settingsSections, type SettingsTab } from "@/lib/settings-navigation";

type Member = {
    id: string;
    email: string;
    companyRole: string;
    instanceRole: string;
    joinedAt: string | null;
};
type TokenScope = "mcp_full" | "mcp_danger" | "requests" | "read_only";

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
    if (scope === "read_only") return "Read only";
    return scope === "mcp_danger" ? "Secret leasing" : scope === "requests" ? "Requests only" : "Agent access";
}

function tokenScopeHelp(scope: TokenScope) {
    if (scope === "read_only") return "For a screen or dashboard that shows what your agents are doing. It can only read the live agent feed (GET /api/mcp/live); it cannot send messages or change anything.";
    if (scope === "requests") return "For another platform that sends work to your agents (a \"send task to agent\" button). It can only create requests and read their status; the token name is shown to agents as the source.";
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
    isPlatformAdmin = false,
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
    /** Ops (runtimes, errors, users across companies) lives here now, not in the main menu. */
    isPlatformAdmin?: boolean;
}) {
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const [tokens, setTokens] = useState(initialTokens);
    const [newTokenName, setNewTokenName] = useState("");
    const [newTokenScope, setNewTokenScope] = useState<TokenScope>("mcp_full");
    const [newTokenCallback, setNewTokenCallback] = useState("");
    const [newTokenPrivateChats, setNewTokenPrivateChats] = useState(false);
    const [editingCallbackId, setEditingCallbackId] = useState<string | null>(null);
    const [callbackDraft, setCallbackDraft] = useState("");

    const [generating, setGenerating] = useState(false);
    const [activeSecret, setActiveSecret] = useState<{ id: string, name: string, secret: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const [revokingTokenId, setRevokingTokenId] = useState<string | null>(null);
    const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
    const [profileDisplayName, setProfileDisplayName] = useState("");
    const [profileRoleTitle, setProfileRoleTitle] = useState("");
    const [savingProfile, setSavingProfile] = useState(false);
    const [profileLoaded, setProfileLoaded] = useState(false);
    const [profileLoading, setProfileLoading] = useState(false);
    const [profileError, setProfileError] = useState(false);
    // Same guard as token creation (POST /api/settings/tokens requires admin).
    const isAdmin = instanceRole === "instance_admin" || companyRole === "owner" || companyRole === "admin";

    const sections = settingsSections({isAdmin,instanceAdmin:instanceRole === 'instance_admin'});
    const activeTab = resolveSettingsTab(searchParams.get('tab'),{isAdmin,instanceAdmin:instanceRole === 'instance_admin'});
    const currentSection = sections.flatMap(section => section.items).find(item => item.id === activeTab)!;
    const setActiveTab = (tab:SettingsTab) => {
        const params = new URLSearchParams(searchParams.toString()); params.set('tab',tab);
        router.push(`${pathname}?${params}`,{scroll:false});
    };

    const loadProfile = async (retry = false) => {
        if (profileLoaded || profileLoading || (profileError && !retry)) return;
        setProfileLoading(true); setProfileError(false);
        try {
            const res = await fetch("/api/user/profile");
            if (!res.ok) throw new Error("Could not load your profile");
            if (res.ok) {
                const data = await res.json();
                setProfileDisplayName(data.displayName || "");
                setProfileRoleTitle(data.roleTitle || "");
            }
        } catch { setProfileError(true); return; }
        finally { setProfileLoading(false); }
        setProfileLoaded(true);
    };

    const saveProfile = async () => {
        if (savingProfile) return;
        setSavingProfile(true);
        try {
            const res = await fetch("/api/user/profile", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ displayName: profileDisplayName, roleTitle: profileRoleTitle }),
            });
            if (!res.ok) throw new Error("Failed");
            toast.success("Profile updated");
        } catch {
            toast.error("Failed to save profile");
        } finally {
            setSavingProfile(false);
        }
    };

    const handleGenerate = async () => {
        if (!newTokenName.trim() || generating) return;
        setGenerating(true);
        setActiveSecret(null);

        try {
            const res = await fetch("/api/settings/tokens", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: newTokenName.trim(),
                    scope: newTokenScope,
                    ...(newTokenScope === "requests" && newTokenCallback.trim() ? { callbackUrl: newTokenCallback.trim() } : {}),
                    ...(newTokenScope === "read_only" && newTokenPrivateChats ? { includePrivateChats: true } : {}),
                }),
            });

            if (res.ok) {
                const data = await res.json();
                setTokens([data.token, ...tokens]);
                setActiveSecret({ id: data.token.id, name: data.token.name, secret: data.secret });
                setNewTokenName("");
                setNewTokenScope("mcp_full");
                setNewTokenCallback("");
                setNewTokenPrivateChats(false);
                toast.success("API key created.");
            } else {
                const data = await res.json().catch(() => ({}));
                toast.error(data.error || "Failed to create API key.");
            }
        } catch (e) {
            console.error(e);
            toast.error("Failed to create API key.");
        } finally {
            setGenerating(false);
        }
    };

    const saveCallback = async (tokenId: string, callbackUrl: string | null) => {
        const res = await fetch(`/api/settings/tokens/${tokenId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callbackUrl }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            toast.error(data.error || "Couldn't save the callback URL");
            return;
        }
        setTokens(tokens.map((t) => (t.id === tokenId ? { ...t, callbackUrlHint: data.token.callbackUrlHint } : t)));
        setEditingCallbackId(null);
        setCallbackDraft("");
        toast.success(callbackUrl ? "Callback URL saved" : "Callback removed");
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
        <div className="mx-auto min-w-0 max-w-[1440px] space-y-6 animate-in fade-in duration-500">
            <PageHeader eyebrow="Workspace" title="Settings" description="Manage your profile, workspace, and connections." />
            <div className="grid min-w-0 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
                <aside className="min-w-0">
                    <label className="block space-y-2 lg:hidden"><span className="text-sm font-medium">Settings section</span><select aria-label="Settings section" value={activeTab} onChange={event => setActiveTab(event.target.value as SettingsTab)} className="min-h-11 w-full rounded-xl border border-border bg-card px-3 text-base">{sections.map(section => <optgroup key={section.label} label={section.label}>{section.items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>)}</select></label>
                    <nav aria-label="Settings sections" className="hidden space-y-5 lg:block">
                        {sections.map(section => <div key={section.label}><p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{section.label}</p><div className="space-y-1">{section.items.map(item => <Link key={item.id} href={`${pathname}?tab=${item.id}`} scroll={false} aria-current={activeTab === item.id ? 'page' : undefined} className={cn('flex min-h-11 items-center rounded-xl px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',activeTab === item.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>{item.label}</Link>)}</div></div>)}
                        {isPlatformAdmin && <Link href="/ops" className="flex min-h-11 items-center rounded-xl border-t border-border px-3 text-sm text-muted-foreground hover:text-foreground">Platform operations ↗</Link>}
                    </nav>
                </aside>
                <div className="min-w-0 space-y-5" aria-label={currentSection.label}>
                    <p className="text-sm leading-6 text-muted-foreground">{currentSection.description}</p>
            {activeTab === "profile" && (
                <ProfileTab
                    displayName={profileDisplayName}
                    setDisplayName={setProfileDisplayName}
                    roleTitle={profileRoleTitle}
                    setRoleTitle={setProfileRoleTitle}
                    onSave={saveProfile}
                    saving={savingProfile}
                    onLoad={loadProfile}
                    loaded={profileLoaded}
                    error={profileError}
                    onRetry={() => void loadProfile(true)}
                />
            )}

            {activeTab === "routines" && (
                <RoutineSettingsTab isAdmin={instanceRole === "instance_admin" || companyRole === "owner" || companyRole === "admin"} />
            )}

            {activeTab === "notifications" && (
                <NotificationSettingsTab isAdmin={instanceRole === "instance_admin" || companyRole === "owner" || companyRole === "admin"} />
            )}

            {activeTab === "connections" && (
                <section className="grid gap-3 sm:gap-4 xl:grid-cols-2">
                    <article className="rounded-2xl border border-border bg-card p-5 sm:p-6 xl:col-span-2"><h2 className="text-lg font-semibold">Start with an agent or a team</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Use the guided setup in Agents. Choose a role, or a ready-made team with a shared chat. Manual runtime guides are below if you already run your own agents.</p><Button asChild className="mt-4 min-h-11"><Link href="/agents">Open agents <IconArrowRight className="h-4 w-4" /></Link></Button></article>
                    {runtimeCards.map((runtime) => (
                        <article key={runtime.title} className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6">
                            <div className="flex items-center gap-3">
                                <div className="grid h-11 w-11 place-items-center rounded-2xl border border-cyan-400/25 bg-cyan-400/10">
                                    <IconPlugConnected className="h-5 w-5 text-primary" />
                                </div>
                                <h2 className="text-xl font-semibold text-foreground">{runtime.title}</h2>
                            </div>
                            <p className="mt-4 text-sm leading-6 text-muted-foreground">{runtime.body}</p>
                            <a href={runtime.href} className="mt-5 inline-flex text-sm font-semibold text-primary hover:text-primary/80">
                                {runtime.cta}
                            </a>
                        </article>
                    ))}
                    <article className="rounded-2xl sm:rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-4 sm:p-6 xl:col-span-2">
                        <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-100">Operator rule</h2>
                        <p className="mt-2 text-sm leading-6 text-amber-700 dark:text-amber-100/75">
                            Create the agent profile in Emperor first, then connect exactly one local runtime profile or workspace to that agent. The runtime can be Hermes or OpenClaw; Emperor should stay runtime-neutral.
                        </p>
                    </article>
                    <details className="rounded-2xl border border-border bg-card p-4 xl:col-span-2"><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Manual setup with an assistant</summary>                    <article className="rounded-2xl sm:rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4 sm:p-6 xl:col-span-2">
                        <div className="flex items-center gap-3">
                            <span className="text-2xl">🤖</span>
                            <h2 className="text-lg font-semibold text-emerald-800 dark:text-emerald-100">Quick Setup — Let your own LLM configure it</h2>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-emerald-700 dark:text-emerald-100/75">
                            Don&apos;t want to configure everything manually? Copy a prompt below, paste it into <strong>Claude, ChatGPT, Codex, or any LLM</strong>, and it will walk you through the entire setup — installing the runtime, configuring the bridge, writing bootstrap files, and tailoring the agent to your role.
                        </p>
                        <div className="mt-4 grid gap-4 sm:grid-cols-2">
                            {/* Hermes prompt */}
                            <div className="rounded-xl border border-emerald-500/30 bg-muted/30 overflow-hidden">
                                <div className="flex items-center justify-between px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20">
                                    <span className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-200">Hermes agent</span>
                                    <CopyPromptButton text={`I need to connect a Hermes agent to Emperor Claw, an open-source AI workforce control plane.

Repo & docs: https://github.com/emperorclaw/emperorclaw
Bridge installer (Linux/Mac): https://emperorclaw.malecu.eu/install-bridge.sh
Bridge installer (Windows): https://emperorclaw.malecu.eu/install-bridge.ps1

My agent role is: [DESCRIBE YOUR ROLE HERE]

Please read the relevant docs and guide me step by step through:
1. Installing Hermes runtime if I don't have it
2. Setting up the Emperor Hermes bridge and plugin
3. Creating the agent profile, SOUL, toolsets, and operating doctrine for this role: [ROLE]
4. Creating a systemd service (or equivalent) to keep it running
5. Connecting to my Emperor Claw instance (I'll give you the URL and token)

Ask me for any info you need along the way.`} />
                                </div>
                                <pre className="p-4 text-xs text-emerald-700 dark:text-emerald-100/80 whitespace-pre-wrap max-h-[260px] overflow-y-auto font-mono leading-relaxed select-all">{`I need to connect a Hermes agent to Emperor Claw, an open-source AI workforce control plane.

Repo & docs: https://github.com/emperorclaw/emperorclaw
Bridge installer (Linux/Mac): https://emperorclaw.malecu.eu/install-bridge.sh
Bridge installer (Windows): https://emperorclaw.malecu.eu/install-bridge.ps1

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
                            <div className="rounded-xl border border-emerald-500/30 bg-muted/30 overflow-hidden">
                                <div className="flex items-center justify-between px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20">
                                    <span className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-200">OpenClaw agent</span>
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
                                <pre className="p-4 text-xs text-emerald-700 dark:text-emerald-100/80 whitespace-pre-wrap max-h-[260px] overflow-y-auto font-mono leading-relaxed select-all">{`I need to configure an OpenClaw agent connected to Emperor Claw, an open-source AI workforce control plane.

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
                        <p className="mt-3 text-xs text-emerald-700/80 dark:text-emerald-100/60">
                            Replace <code className="bg-emerald-500/15 px-1 rounded text-emerald-800 dark:text-emerald-200">[DESCRIBE YOUR ROLE HERE]</code> with your agent&apos;s actual role — e.g. &quot;SEO Specialist&quot;, &quot;Lead Generation Agent&quot;, &quot;Technical Implementation Agent&quot;. The more specific you are, the better the result.
                        </p>
                    </article></details>
                </section>
            )}

            {activeTab === "tokens" && (
                <section className="grid gap-4 sm:gap-6 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,1.2fr)]">
                    <div className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6">
                        <h2 className="mb-4 flex items-center text-lg font-semibold text-foreground">
                            <IconKey className="mr-2 h-5 w-5 text-primary" /> Create access token
                        </h2>
                        <div className="space-y-4">
                            <label className="block space-y-2">
                                <span className="text-sm font-medium text-foreground">Token name</span>
                                <Input
                                    type="text"
                                    placeholder="e.g. Pi bridge, Growth agent, QA runtime"
                                    value={newTokenName}
                                    onChange={(event) => setNewTokenName(event.target.value)}
                                />
                            </label>
                            <label className="block space-y-2">
                                <span className="text-sm font-medium text-foreground">Access level</span>
                                <select
                                    value={newTokenScope}
                                    onChange={(event) => setNewTokenScope(event.target.value as TokenScope)}
                                    className="h-10 w-full rounded-xl border border-border bg-muted/30 px-3 text-sm text-foreground outline-none focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20"
                                >
                                    <option value="mcp_full">Agent access</option>
                                    <option value="mcp_danger">Secret leasing</option>
                                    <option value="requests">Requests only (another platform)</option>
                                    <option value="read_only">Read only (screens &amp; dashboards)</option>
                                </select>
                                <p className="text-xs leading-5 text-muted-foreground">{tokenScopeHelp(newTokenScope)}</p>
                            </label>
                            {newTokenScope === "requests" && (
                                <label className="block space-y-2">
                                    <span className="text-sm font-medium text-foreground">Callback URL <span className="font-normal text-muted-foreground">(optional)</span></span>
                                    <Input
                                        type="url"
                                        placeholder="https://your-platform.example/emperor/callback"
                                        value={newTokenCallback}
                                        onChange={(event) => setNewTokenCallback(event.target.value)}
                                    />
                                    <p className="text-xs leading-5 text-muted-foreground">Emperor posts a signed update here whenever a request changes status. Stored encrypted.</p>
                                </label>
                            )}
                            {newTokenScope === "read_only" && (
                                <label className="flex items-start gap-3 rounded-xl border border-border bg-white/[0.02] p-3">
                                    <input
                                        type="checkbox"
                                        className="mt-0.5 h-4 w-4 accent-cyan-400"
                                        checked={newTokenPrivateChats}
                                        onChange={(event) => setNewTokenPrivateChats(event.target.checked)}
                                    />
                                    <span className="space-y-1">
                                        <span className="block text-sm font-medium text-foreground">Include my private chats</span>
                                        <span className="block text-xs leading-5 text-muted-foreground">Shows your own direct conversations with each agent on the screen. Never includes other people&apos;s chats. Anyone who can see the screen can read them.</span>
                                    </span>
                                </label>
                            )}
                            <Button onClick={handleGenerate} disabled={!newTokenName.trim() || generating} className="w-full">
                                <IconPlus className="h-4 w-4" /> {generating ? "Creating..." : "Create token"}
                            </Button>
                        </div>

                        {activeSecret && (
                            <div className="mt-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
                                <div className="flex items-start gap-3">
                                    <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-300" />
                                    <div>
                                        <h3 className="font-medium text-emerald-800 dark:text-emerald-200">Token created</h3>
                                        <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-100/75">Copy it now. Emperor will not show this secret again.</p>
                                    </div>
                                </div>
                                <div className="mt-4 flex overflow-hidden rounded-xl border border-border bg-muted/30">
                                    <code className="flex-1 overflow-x-auto px-4 py-3 font-mono text-sm text-foreground">{activeSecret.secret}</code>
                                    <button onClick={copyToClipboard} className="cursor-pointer border-l border-border px-4 text-muted-foreground transition-colors hover:bg-white/[0.045] hover:text-foreground">
                                        {copied ? <IconCircleCheck className="h-4 w-4 text-emerald-300" /> : <IconCopy className="h-4 w-4" />}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="overflow-hidden rounded-2xl sm:rounded-2xl border border-border bg-background/70">
                        <div className="border-b border-border p-4 sm:p-5">
                            <h2 className="text-lg font-semibold text-foreground">Active tokens</h2>
                            <p className="mt-1 text-sm text-muted-foreground">Revoke anything that is no longer attached to a real runtime.</p>
                        </div>
                        <div className="divide-y divide-white/10">
                            {tokens.length === 0 ? (
                                <div className="p-8 text-center text-sm text-muted-foreground">No access tokens active. Create one to connect an agent runtime.</div>
                            ) : (
                                tokens.map((token) => (
                                    <div key={token.id} className="flex flex-col gap-3 sm:gap-4 p-4 sm:p-5 transition-colors hover:bg-white/[0.025] sm:flex-row sm:items-center sm:justify-between">
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h3 className="font-medium text-foreground">{token.name}</h3>
                                                <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-200">
                                                    {tokenScopeLabel(token.scope)}
                                                </span>
                                                {token.scope === "read_only" && token.includePrivateChats && (
                                                    <span className="text-xs text-muted-foreground">+ my private chats</span>
                                                )}
                                            </div>
                                            <p className="mt-1 font-mono text-xs text-muted-foreground">
                                                ID: {token.id} · Created: {new Date(token.createdAt).toLocaleDateString()} · Expires: {new Date(token.expiresAt).toLocaleDateString()}
                                            </p>
                                            <p className="mt-1 text-xs text-muted-foreground">Last used: {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "Never"}</p>
                                            {token.scope === "requests" && (
                                                editingCallbackId === token.id ? (
                                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                                        <Input type="url" className="h-8 max-w-xs text-xs" placeholder="https://…/callback" value={callbackDraft} onChange={(event) => setCallbackDraft(event.target.value)} aria-label="Callback URL" />
                                                        <Button size="sm" onClick={() => saveCallback(token.id, callbackDraft.trim())} disabled={!callbackDraft.trim()}>Save</Button>
                                                        <Button size="sm" variant="ghost" onClick={() => setEditingCallbackId(null)}>Cancel</Button>
                                                    </div>
                                                ) : (
                                                    <p className="mt-1 text-xs text-muted-foreground">
                                                        Callback: {token.callbackUrlHint ? <span className="font-mono">{token.callbackUrlHint}</span> : "none"}{" · "}
                                                        <button className="cursor-pointer text-primary hover:underline" onClick={() => { setEditingCallbackId(token.id); setCallbackDraft(""); }}>{token.callbackUrlHint ? "Change" : "Add"}</button>
                                                        {token.callbackUrlHint && <>{" · "}<button className="cursor-pointer text-muted-foreground hover:underline" onClick={() => saveCallback(token.id, null)}>Remove</button></>}
                                                    </p>
                                                )
                                            )}
                                        </div>
                                        <Button variant="destructive" size="sm" onClick={() => handleRevokeToken(token.id)} disabled={revokingTokenId === token.id}>
                                            <IconTrash className="h-4 w-4" /> {revokingTokenId === token.id ? "Revoking..." : confirmingRevokeId === token.id ? "Click again to confirm" : "Revoke"}
                                        </Button>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    <div className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6 xl:col-span-2">
                        <h2 className="mb-2 flex items-center text-lg font-semibold text-foreground">
                            <IconPlugConnected className="mr-2 h-5 w-5 text-primary" /> Connect Claude, Codex, or another MCP client
                        </h2>
                        <p className="text-sm leading-6 text-muted-foreground">
                            Emperor exposes a real Model Context Protocol server at <code className="rounded bg-muted/30 px-1 py-0.5 font-mono text-xs text-foreground">/mcp</code> — point any MCP-capable client at it with an <strong>Agent access</strong> token from above to get every agent/task/project/Knowledge &amp; Rules/messaging tool, plus your company&apos;s operating doctrine, automatically.
                        </p>
                        <div className="mt-4 space-y-2 rounded-xl border border-border bg-background p-4">
                            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">URL</p>
                            <code className="block whitespace-pre-wrap font-mono text-sm text-foreground">{`${typeof window !== "undefined" ? window.location.origin : ""}/mcp`}</code>
                            <p className="pt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Header</p>
                            <code className="block whitespace-pre-wrap font-mono text-sm text-foreground">Authorization: Bearer &lt;your token&gt;</code>
                        </div>
                        <details className="mt-3 rounded-2xl border border-border bg-muted/30 p-4">
                            <summary className="cursor-pointer text-sm font-semibold text-foreground">Claude Desktop config example</summary>
                            <pre className="mt-3 overflow-x-auto rounded-xl border border-border bg-background p-4 font-mono text-xs leading-6 text-foreground">{`{
  "mcpServers": {
    "emperorclaw": {
      "url": "${typeof window !== "undefined" ? window.location.origin : "https://your-emperorclaw-host"}/mcp",
      "headers": {
        "Authorization": "Bearer <your token>"
      }
    }
  }
}`}</pre>
                            <p className="mt-3 text-xs leading-5 text-muted-foreground">
                                Edit this in Claude Desktop&apos;s config file directly.
                            </p>
                        </details>
                        <details className="mt-3 rounded-2xl border border-border bg-muted/30 p-4">
                            <summary className="cursor-pointer text-sm font-semibold text-foreground">Connect via claude.ai web (Connectors)</summary>
                            <p className="mt-3 text-xs leading-5 text-muted-foreground">
                                Add a custom connector and paste just the URL above — no manual Client ID/Secret needed. Emperor registers Claude automatically and you&apos;ll be asked to approve the connection while logged in here; no separate token is required for this path.
                            </p>
                            <p className="mt-2 text-xs leading-5 text-amber-300/80">
                                Requires this instance to be served over HTTPS (a reverse proxy with a real certificate — Caddy, nginx, Cloudflare Tunnel). Self-hosted installs on plain HTTP (e.g. a LAN IP with no proxy) should use the manual token method above instead.
                            </p>
                        </details>
                    </div>
                </section>
            )}

            {activeTab === "displays" && isAdmin && (
                <DisplaysTab
                    tokens={tokens}
                    onTokenCreated={(token) => setTokens((prev) => [{ expiresAt: "", ...token }, ...prev])}
                    onTokenRemoved={(id) => setTokens((prev) => prev.filter((t) => t.id !== id))}
                    onRevoke={handleRevokeToken}
                    revokingTokenId={revokingTokenId}
                    confirmingRevokeId={confirmingRevokeId}
                />
            )}

            {activeTab === "updates" && <UpdateSettingsTab />}

            {activeTab === "advanced" && (
                <section className="space-y-4">
                    <div className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6">
                        <h2 className="flex items-center text-lg font-semibold text-foreground">
                            <IconPlugConnected className="mr-2 h-5 w-5 text-primary" /> Advanced runtime setup
                        </h2>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            Use this when manually validating a local companion, bridge, heartbeats, checkpoints, or token permissions. Most operators only need the runtime guides above.
                        </p>
                        <details className="mt-5 rounded-2xl border border-border bg-muted/30 p-4">
                            <summary className="cursor-pointer text-sm font-semibold text-foreground">Show OpenClaw plugin commands</summary>
                            <div className="mt-4 space-y-3 rounded-xl border border-border bg-background p-4">
                                <code className="block whitespace-pre-wrap font-mono text-sm text-foreground">openclaw plugins install clawhub:emperor-claw-os-plugin</code>
                                <code className="block whitespace-pre-wrap font-mono text-sm text-foreground">openclaw emperor add-agent --agent-name &quot;Operator One&quot; --local-brain-agent-id operator-one --token &quot;your_token_here&quot; --profile operator</code>
                                <code className="block whitespace-pre-wrap font-mono text-sm text-foreground">EMPEROR_CLAW_API_TOKEN=your_token_here openclaw emperor doctor</code>
                                <code className="block whitespace-pre-wrap font-mono text-sm text-foreground">EMPEROR_CLAW_API_TOKEN=your_token_here openclaw emperor status</code>
                            </div>
                        </details>
                        <details className="mt-3 rounded-2xl border border-border bg-muted/30 p-4">
                            <summary className="cursor-pointer text-sm font-semibold text-foreground">Show token scope internals</summary>
                            <p className="mt-3 text-sm leading-6 text-muted-foreground">
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
                    embedded
                    currentUserId={currentUserId}
                    currentUserRole={currentUserRole}
                    companyId={companyId}
                    initialMembers={initialMembers}
                    agents={agents}
                    customersData={customersData}
                />
            )}
                </div>
            </div>
        </div>
    );
}

function ProfileTab({ displayName, setDisplayName, roleTitle, setRoleTitle, onSave, saving, onLoad, loaded, error, onRetry }: { displayName: string; setDisplayName: (v: string) => void; roleTitle: string; setRoleTitle: (v: string) => void; onSave: () => void; saving: boolean; onLoad: () => void; loaded: boolean; error:boolean; onRetry:()=>void }) {
    useEffect(() => { if (!loaded) onLoad(); }, [loaded, onLoad]);
    return (
        <section className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6 max-w-lg">
            <h2 className="flex items-center text-lg font-semibold text-foreground mb-4">
                <IconUsers className="mr-2 h-5 w-5 text-primary" /> Your Profile
            </h2>
            <p className="text-sm text-muted-foreground mb-6">Agents can see this info to know who to contact for what.</p>
            {error && <p role="alert" className="mb-4 text-sm text-destructive">Could not load your profile. <button type="button" onClick={onRetry} className="min-h-11 underline">Retry</button></p>}
            {!loaded && !error && <p role="status" className="mb-4 text-sm text-muted-foreground">Loading your profile…</p>}
            <div className="space-y-4">
                <label className="block">
                    <span className="text-sm font-medium text-foreground">Display Name</span>
                    <input disabled={!loaded} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your full name" className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-cyan-400" />
                </label>
                <label className="block">
                    <span className="text-sm font-medium text-foreground">Role / Title</span>
                    <input disabled={!loaded} value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} placeholder="e.g. SEO Lead, Project Manager, Client Contact" className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-cyan-400" />
                    <p className="mt-1 text-xs text-muted-foreground">Free text — helps agents know what you&apos;re responsible for.</p>
                </label>
                <button onClick={onSave} disabled={saving || !loaded} className="min-h-11 cursor-pointer rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                    {saving ? "Saving..." : "Save Profile"}
                </button>
            </div>
        </section>
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
            <div className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6">
                <h2 className="flex items-center text-lg font-semibold text-foreground">
                    <IconSettings className="mr-2 h-5 w-5 text-primary" /> Instance configuration
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    These settings apply to the entire self-hosted instance. Only the instance administrator can change them.
                </p>

                <div className="mt-6 space-y-4">
                    <div className="flex items-center justify-between rounded-xl border border-border bg-muted/30 p-4">
                        <div>
                            <h3 className="font-medium text-foreground">Registration mode</h3>
                            <p className="mt-1 text-sm text-muted-foreground">
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

                    <div className="rounded-xl border border-border bg-muted/30 p-4">
                        <h3 className="font-medium text-foreground">Instance name</h3>
                        <p className="mt-1 text-sm text-muted-foreground">Display name shown in emails and page titles.</p>
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
