"use client";

import { useEffect, useState } from "react";
import { IconAlertTriangle, IconArrowRight, IconPlugConnected, IconCircleCheck, IconCopy, IconKey, IconPlus, IconSettings, IconTrash } from "@tabler/icons-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { useFormatter, useTranslations } from "next-intl";
import { PageHeader } from "@/components/page-header";
import { SampleDataCard } from "@/components/sample-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { UpdateSettingsTab } from "@/components/update-settings-tab";
import MembersClient from "./members/members-client";
import { NotificationSettingsTab } from "./notification-settings-tab";
import { RoutineSettingsTab } from "./routine-settings-tab";
import { DirectChatSettingsTab } from "./direct-chat-settings-tab";
import { DisplaysTab } from "./displays-tab";
import { ModulesSettingsTab } from "./modules-settings-tab";
import { RuntimeHostsTab } from "./runtime-hosts-tab";
import { ProfileTab } from "./profile-tab";
import type { ModuleState } from "@/lib/modules";

type SettingsToken = {
    id: string;
    name: string;
    scope: string;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string;
    callbackUrlHint?: string | null;
    includePrivateChats?: boolean;
    includeAgentThoughts?: boolean;
};

import { resolveSettingsTab, settingsItemKey, settingsSections, type SettingsTab } from "@/lib/settings-navigation";
import type { Locale } from "@/i18n/config";

type Member = {
    id: string;
    email: string;
    companyRole: string;
    instanceRole: string;
    joinedAt: string | null;
};
type TokenScope = "mcp_full" | "mcp_danger" | "requests" | "read_only";

/** Labelled by settings.connections.runtimes.<key>. */
const runtimeCards = [
    { key: "hermes", href: "/docs/v1.1/hermes-runtime" },
    { key: "openclaw", href: "/docs/v1.1/openclaw-agents" },
] as const;

/** Token scopes with a label under settings.tokens.scopes. */
function tokenScopeKey(scope: string): TokenScope {
    return scope === "read_only" || scope === "mcp_danger" || scope === "requests" ? scope : "mcp_full";
}

/**
 * Prompts a person pastes into their own LLM to set up a runtime. They stay
 * English on purpose: they instruct a model about English docs and files.
 */
const HERMES_SETUP_PROMPT = `I need to connect a Hermes agent to Emperor Claw, an open-source AI workforce control plane.

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

Ask me for any info you need along the way.`;

const OPENCLAW_SETUP_PROMPT = `I need to configure an OpenClaw agent connected to Emperor Claw, an open-source AI workforce control plane.

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

Walk me through step by step.`;

/** Shell commands, never translated. */
const OPENCLAW_COMMANDS = [
    "openclaw plugins install clawhub:emperor-claw-os-plugin",
    'openclaw emperor add-agent --agent-name "Operator One" --local-brain-agent-id operator-one --token "your_token_here" --profile operator',
    "EMPEROR_CLAW_API_TOKEN=your_token_here openclaw emperor doctor",
    "EMPEROR_CLAW_API_TOKEN=your_token_here openclaw emperor status",
];

const mcpUrl = () => `${typeof window !== "undefined" ? window.location.origin : ""}/mcp`;
const authHeader = (token: string) => `Authorization: Bearer <${token}>`;
const claudeDesktopConfig = (token: string) => `{
  "mcpServers": {
    "emperorclaw": {
      "url": "${typeof window !== "undefined" ? window.location.origin : "https://your-emperorclaw-host"}/mcp",
      "headers": {
        "Authorization": "Bearer <${token}>"
      }
    }
  }
}`;
const ROLE_PLACEHOLDER = "[DESCRIBE YOUR ROLE HERE]";
const CALLBACK_EXAMPLE = "https://your-platform.example/emperor/callback";
const CALLBACK_SHORT_EXAMPLE = "https://…/callback";

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
    modules,
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
    /** Tabs that belong to a module (Displays) hide while it is off. */
    modules?: ModuleState;
}) {
    const tSettings = useTranslations("settings");
    const t = useTranslations("settings");
    const tc = useTranslations("common");
    const format = useFormatter();
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
    const [profileLocale, setProfileLocale] = useState<Locale | null>(null);
    const [savingProfile, setSavingProfile] = useState(false);
    const [profileLoaded, setProfileLoaded] = useState(false);
    const [profileLoading, setProfileLoading] = useState(false);
    const [profileError, setProfileError] = useState(false);
    // Same guard as token creation (POST /api/settings/tokens requires admin).
    const isAdmin = instanceRole === "instance_admin" || companyRole === "owner" || companyRole === "admin";

    const sections = settingsSections({isAdmin,instanceAdmin:instanceRole === 'instance_admin',modules});
    const activeTab = resolveSettingsTab(searchParams.get('tab'),{isAdmin,instanceAdmin:instanceRole === 'instance_admin',modules});
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
            if (!res.ok) throw new Error("profile");
            if (res.ok) {
                const data = await res.json();
                setProfileDisplayName(data.displayName || "");
                setProfileRoleTitle(data.roleTitle || "");
                setProfileLocale(data.locale ?? null);
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
            toast.success(tSettings("profile.updated"));
        } catch {
            toast.error(tSettings("profile.saveFailed"));
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
                toast.success(t("tokens.created"));
            } else {
                const data = await res.json().catch(() => ({}));
                toast.error(data.error || t("tokens.createFailed"));
            }
        } catch (e) {
            console.error(e);
            toast.error(t("tokens.createFailed"));
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
            toast.error(data.error || t("tokens.callbackFailed"));
            return;
        }
        setTokens(tokens.map((token) => (token.id === tokenId ? { ...token, callbackUrlHint: data.token.callbackUrlHint } : token)));
        setEditingCallbackId(null);
        setCallbackDraft("");
        toast.success(callbackUrl ? t("tokens.callbackSaved") : t("tokens.callbackRemoved"));
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
                toast.success(t("tokens.revoked"));
            } else {
                console.error("Failed to revoke token");
                toast.error(t("tokens.revokeFailed"));
            }
        } catch (error) {
            console.error(error);
            toast.error(t("tokens.revokeFailed"));
        } finally {
            setRevokingTokenId(null);
        }
    };

    return (
        <div className="mx-auto min-w-0 max-w-[1440px] @container space-y-6 animate-in fade-in duration-500">
            <PageHeader eyebrow={t("page.eyebrow")} title={t("page.title")} description={t("page.description")} />
            {isAdmin && <SampleDataCard />}
            <div className="grid min-w-0 gap-6 @min-[900px]:grid-cols-[200px_minmax(0,1fr)]">
                <aside className="min-w-0">
                    <label className="block space-y-2 @min-[900px]:hidden"><span className="text-sm font-medium">{t("page.section")}</span><select aria-label={t("page.section")} value={activeTab} onChange={event => setActiveTab(event.target.value as SettingsTab)} className="min-h-11 w-full rounded-xl border border-border bg-card px-3 text-base">{sections.map(section => <optgroup key={section.id} label={tSettings(`sections.${section.id}`)}>{section.items.map(item => <option key={item.id} value={item.id}>{tSettings(`items.${settingsItemKey(item.id)}`)}</option>)}</optgroup>)}</select></label>
                    <nav aria-label={t("page.sections")} className="hidden space-y-5 @min-[900px]:block">
                        {sections.map(section => <div key={section.id}><p className="mb-3 flex items-center gap-3 px-3 text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground"><span>{tSettings(`sections.${section.id}`)}</span><span aria-hidden="true" className="h-px flex-1 bg-border" /></p><div className="space-y-1">{section.items.map(item => <Link key={item.id} href={`${pathname}?tab=${item.id}`} scroll={false} aria-current={activeTab === item.id ? 'page' : undefined} className={cn('flex min-h-11 items-center rounded-xl px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',activeTab === item.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>{tSettings(`items.${settingsItemKey(item.id)}`)}</Link>)}</div></div>)}
                        {isPlatformAdmin && <Link href="/ops" className="flex min-h-11 items-center rounded-xl border-t border-border px-3 text-sm text-muted-foreground hover:text-foreground">{t("page.platformOps")}</Link>}
                    </nav>
                </aside>
                <div className="min-w-0 space-y-5" aria-label={tSettings(`items.${settingsItemKey(currentSection.id)}`)}>
                    <p className="text-sm leading-6 text-muted-foreground">{tSettings(`items.${settingsItemKey(currentSection.id)}Description`)}</p>
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
                    locale={profileLocale}
                    onLocaleChange={setProfileLocale}
                />
            )}

            {activeTab === "routines" && (
                <RoutineSettingsTab isAdmin={instanceRole === "instance_admin" || companyRole === "owner" || companyRole === "admin"} />
            )}

            {activeTab === "direct-chats" && isAdmin && (
                <DirectChatSettingsTab isAdmin={isAdmin} />
            )}

            {activeTab === "modules" && isAdmin && (
                <ModulesSettingsTab isAdmin={isAdmin} />
            )}

            {activeTab === "runtime-hosts" && isAdmin && (
                <RuntimeHostsTab />
            )}

            {activeTab === "notifications" && (
                <NotificationSettingsTab isAdmin={instanceRole === "instance_admin" || companyRole === "owner" || companyRole === "admin"} />
            )}

            {activeTab === "connections" && (
                <section className="grid gap-3 sm:gap-4 xl:grid-cols-2">
                    <article className="rounded-2xl border border-border bg-card p-5 sm:p-6 xl:col-span-2"><h2 className="text-lg font-semibold">{t("connections.startTitle")}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{t("connections.startBody")}</p><Button asChild className="mt-4 min-h-11"><Link href="/agents">{t("connections.openAgents")} <IconArrowRight className="h-4 w-4" /></Link></Button></article>
                    {runtimeCards.map((runtime) => (
                        <article key={runtime.key} className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6">
                            <div className="flex items-center gap-3">
                                <div className="grid h-11 w-11 place-items-center rounded-2xl border border-cyan-400/25 bg-cyan-400/10">
                                    <IconPlugConnected className="h-5 w-5 text-primary" />
                                </div>
                                <h2 className="text-xl font-semibold text-foreground">{t(`connections.runtimes.${runtime.key}.title`)}</h2>
                            </div>
                            <p className="mt-4 text-sm leading-6 text-muted-foreground">{t(`connections.runtimes.${runtime.key}.body`)}</p>
                            <a href={runtime.href} className="mt-5 inline-flex text-sm font-semibold text-primary hover:text-primary/80">
                                {t(`connections.runtimes.${runtime.key}.cta`)}
                            </a>
                        </article>
                    ))}
                    <article className="rounded-2xl sm:rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-4 sm:p-6 xl:col-span-2">
                        <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-100">{t("connections.operatorRule")}</h2>
                        <p className="mt-2 text-sm leading-6 text-amber-700 dark:text-amber-100/75">
                            {t("connections.operatorRuleBody")}
                        </p>
                    </article>
                    <details className="rounded-2xl border border-border bg-card p-4 xl:col-span-2"><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{t("connections.manualSetup")}</summary>                    <article className="rounded-2xl sm:rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4 sm:p-6 xl:col-span-2">
                        <div className="flex items-center gap-3">
                            <span className="text-2xl" aria-hidden="true">{"🤖"}</span>
                            <h2 className="text-lg font-semibold text-emerald-800 dark:text-emerald-100">{t("connections.quickSetupTitle")}</h2>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-emerald-700 dark:text-emerald-100/75">
                            {t.rich("connections.quickSetupBody", { strong: (chunks) => <strong>{chunks}</strong> })}
                        </p>
                        <div className="mt-4 grid gap-4 sm:grid-cols-2">
                            {/* Hermes prompt */}
                            <div className="rounded-xl border border-emerald-500/30 bg-muted/30 overflow-hidden">
                                <div className="flex items-center justify-between px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20">
                                    <span className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-200">{t("connections.hermesAgent")}</span>
                                    <CopyPromptButton text={HERMES_SETUP_PROMPT} />
                                </div>
                                <pre className="p-4 text-xs text-emerald-700 dark:text-emerald-100/80 whitespace-pre-wrap max-h-[260px] overflow-y-auto font-mono leading-relaxed select-all">{HERMES_SETUP_PROMPT}</pre>
                            </div>

                            {/* OpenClaw prompt */}
                            <div className="rounded-xl border border-emerald-500/30 bg-muted/30 overflow-hidden">
                                <div className="flex items-center justify-between px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20">
                                    <span className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-200">{t("connections.openclawAgent")}</span>
                                    <CopyPromptButton text={OPENCLAW_SETUP_PROMPT} />
                                </div>
                                <pre className="p-4 text-xs text-emerald-700 dark:text-emerald-100/80 whitespace-pre-wrap max-h-[260px] overflow-y-auto font-mono leading-relaxed select-all">{OPENCLAW_SETUP_PROMPT}</pre>
                            </div>
                        </div>
                        <p className="mt-3 text-xs text-emerald-700/80 dark:text-emerald-100/60">
                            {t.rich("connections.replaceRole", { placeholder: ROLE_PLACEHOLDER, code: (chunks) => <code className="bg-emerald-500/15 px-1 rounded text-emerald-800 dark:text-emerald-200">{chunks}</code> })}
                        </p>
                    </article></details>
                </section>
            )}

            {activeTab === "tokens" && (
                <section className="grid gap-4 sm:gap-6 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,1.2fr)]">
                    <div className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6">
                        <h2 className="mb-4 flex items-center text-lg font-semibold text-foreground">
                            <IconKey className="mr-2 h-5 w-5 text-primary" /> {t("tokens.createTitle")}
                        </h2>
                        <div className="space-y-4">
                            <label className="block space-y-2">
                                <span className="text-sm font-medium text-foreground">{t("tokens.name")}</span>
                                <Input
                                    type="text"
                                    placeholder={t("tokens.namePlaceholder")}
                                    value={newTokenName}
                                    onChange={(event) => setNewTokenName(event.target.value)}
                                />
                            </label>
                            <label className="block space-y-2">
                                <span className="text-sm font-medium text-foreground">{t("tokens.accessLevel")}</span>
                                <select
                                    value={newTokenScope}
                                    onChange={(event) => setNewTokenScope(event.target.value as TokenScope)}
                                    className="h-10 w-full rounded-xl border border-border bg-muted/30 px-3 text-sm text-foreground outline-none focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20"
                                >
                                    <option value="mcp_full">{t("tokens.options.mcp_full")}</option>
                                    <option value="mcp_danger">{t("tokens.options.mcp_danger")}</option>
                                    <option value="requests">{t("tokens.options.requests")}</option>
                                    <option value="read_only">{t("tokens.options.read_only")}</option>
                                </select>
                                <p className="text-xs leading-5 text-muted-foreground">{t(`tokens.help.${newTokenScope}`)}</p>
                            </label>
                            {newTokenScope === "requests" && (
                                <label className="block space-y-2">
                                    <span className="text-sm font-medium text-foreground">{t("tokens.callbackUrl")} <span className="font-normal text-muted-foreground">{t("tokens.optional")}</span></span>
                                    <Input
                                        type="url"
                                        placeholder={CALLBACK_EXAMPLE}
                                        value={newTokenCallback}
                                        onChange={(event) => setNewTokenCallback(event.target.value)}
                                    />
                                    <p className="text-xs leading-5 text-muted-foreground">{t("tokens.callbackHint")}</p>
                                </label>
                            )}
                            {newTokenScope === "read_only" && (
                                <label className="flex items-start gap-3 rounded-xl border border-border bg-black/[0.03] dark:bg-white/[0.02] p-3">
                                    <input
                                        type="checkbox"
                                        className="mt-0.5 h-4 w-4 accent-cyan-400"
                                        checked={newTokenPrivateChats}
                                        onChange={(event) => setNewTokenPrivateChats(event.target.checked)}
                                    />
                                    <span className="space-y-1">
                                        <span className="block text-sm font-medium text-foreground">{t("displays.privateChats")}</span>
                                        <span className="block text-xs leading-5 text-muted-foreground">{t("displays.privateChatsHelp")}</span>
                                    </span>
                                </label>
                            )}
                            <Button onClick={handleGenerate} disabled={!newTokenName.trim() || generating} className="w-full">
                                <IconPlus className="h-4 w-4" /> {generating ? t("tokens.creating") : t("tokens.create")}
                            </Button>
                        </div>

                        {activeSecret && (
                            <div className="mt-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
                                <div className="flex items-start gap-3">
                                    <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-300" />
                                    <div>
                                        <h3 className="font-medium text-emerald-800 dark:text-emerald-200">{t("tokens.createdTitle")}</h3>
                                        <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-100/75">{t("tokens.copyNow")}</p>
                                    </div>
                                </div>
                                <div className="mt-4 flex overflow-hidden rounded-xl border border-border bg-muted/30">
                                    <code className="flex-1 overflow-x-auto px-4 py-3 font-mono text-sm text-foreground">{activeSecret.secret}</code>
                                    <button onClick={copyToClipboard} aria-label={copied ? tc("copied") : tc("copy")} className="cursor-pointer border-l border-border px-4 text-muted-foreground transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.045] hover:text-foreground">
                                        {copied ? <IconCircleCheck className="h-4 w-4 text-emerald-300" /> : <IconCopy className="h-4 w-4" />}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="overflow-hidden rounded-2xl sm:rounded-2xl border border-border bg-background/70">
                        <div className="border-b border-border p-4 sm:p-5">
                            <h2 className="text-lg font-semibold text-foreground">{t("tokens.activeTitle")}</h2>
                            <p className="mt-1 text-sm text-muted-foreground">{t("tokens.activeIntro")}</p>
                        </div>
                        <div className="divide-y divide-border">
                            {tokens.length === 0 ? (
                                <div className="p-8 text-center text-sm text-muted-foreground">{t("tokens.empty")}</div>
                            ) : (
                                tokens.map((token) => (
                                    <div key={token.id} className="flex flex-col gap-3 sm:gap-4 p-4 sm:p-5 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.025] sm:flex-row sm:items-center sm:justify-between">
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h3 className="font-medium text-foreground">{token.name}</h3>
                                                <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-cyan-700 dark:text-cyan-200">
                                                    {t(`tokens.scopes.${tokenScopeKey(token.scope)}`)}
                                                </span>
                                                {token.scope === "read_only" && token.includePrivateChats && (
                                                    <span className="text-xs text-muted-foreground">{t("tokens.plusPrivateChats")}</span>
                                                )}
                                                {token.scope === "read_only" && token.includeAgentThoughts && (
                                                    <span className="text-xs text-muted-foreground">{t("tokens.plusThoughts")}</span>
                                                )}
                                            </div>
                                            <p className="mt-1 font-mono text-xs text-muted-foreground">
                                                {t("tokens.meta", { id: token.id, created: format.dateTime(new Date(token.createdAt), { dateStyle: "medium" }), expires: token.expiresAt ? format.dateTime(new Date(token.expiresAt), { dateStyle: "medium" }) : "—" })}
                                            </p>
                                            <p className="mt-1 text-xs text-muted-foreground">{t("tokens.lastUsed", { when: token.lastUsedAt ? format.dateTime(new Date(token.lastUsedAt), { dateStyle: "medium", timeStyle: "short" }) : t("tokens.never") })}</p>
                                            {token.scope === "requests" && (
                                                editingCallbackId === token.id ? (
                                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                                        <Input type="url" className="h-11 max-w-xs text-sm" placeholder={CALLBACK_SHORT_EXAMPLE} value={callbackDraft} onChange={(event) => setCallbackDraft(event.target.value)} aria-label={t("tokens.callbackUrl")} />
                                                        <Button size="sm" onClick={() => saveCallback(token.id, callbackDraft.trim())} disabled={!callbackDraft.trim()}>{tc("save")}</Button>
                                                        <Button size="sm" variant="ghost" onClick={() => setEditingCallbackId(null)}>{tc("cancel")}</Button>
                                                    </div>
                                                ) : (
                                                    <p className="mt-1 text-xs text-muted-foreground">
                                                        {t("tokens.callbackLabel")} {token.callbackUrlHint ? <span className="font-mono">{token.callbackUrlHint}</span> : t("tokens.callbackNone")}{" · "}
                                                        <button className="cursor-pointer text-primary hover:underline" onClick={() => { setEditingCallbackId(token.id); setCallbackDraft(""); }}>{token.callbackUrlHint ? t("tokens.change") : tc("add")}</button>
                                                        {token.callbackUrlHint && <>{" · "}<button className="cursor-pointer text-muted-foreground hover:underline" onClick={() => saveCallback(token.id, null)}>{tc("remove")}</button></>}
                                                    </p>
                                                )
                                            )}
                                        </div>
                                        <Button variant="destructive" size="sm" onClick={() => handleRevokeToken(token.id)} disabled={revokingTokenId === token.id}>
                                            <IconTrash className="h-4 w-4" /> {revokingTokenId === token.id ? t("displays.revoking") : confirmingRevokeId === token.id ? t("displays.confirmRevoke") : t("displays.revoke")}
                                        </Button>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    <div className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6 xl:col-span-2">
                        <h2 className="mb-2 flex items-center text-lg font-semibold text-foreground">
                            <IconPlugConnected className="mr-2 h-5 w-5 text-primary" /> {t("tokens.mcpTitle")}
                        </h2>
                        <p className="text-sm leading-6 text-muted-foreground">
                            {t.rich("tokens.mcpBody", { code: (chunks) => <code className="rounded bg-muted/30 px-1 py-0.5 font-mono text-xs text-foreground">{chunks}</code>, strong: (chunks) => <strong>{chunks}</strong> })}
                        </p>
                        <div className="mt-4 space-y-2 rounded-xl border border-border bg-background p-4">
                            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">URL</p>
                            <code className="block whitespace-pre-wrap font-mono text-sm text-foreground">{mcpUrl()}</code>
                            <p className="pt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("tokens.header")}</p>
                            <code className="block whitespace-pre-wrap font-mono text-sm text-foreground">{authHeader(t("tokens.yourToken"))}</code>
                        </div>
                        <details className="mt-3 rounded-2xl border border-border bg-muted/30 p-4">
                            <summary className="cursor-pointer text-sm font-semibold text-foreground">{t("tokens.claudeDesktop")}</summary>
                            <pre className="mt-3 overflow-x-auto rounded-xl border border-border bg-background p-4 font-mono text-xs leading-6 text-foreground">{claudeDesktopConfig(t("tokens.yourToken"))}</pre>
                            <p className="mt-3 text-xs leading-5 text-muted-foreground">
                                {t("tokens.claudeDesktopHint")}
                            </p>
                        </details>
                        <details className="mt-3 rounded-2xl border border-border bg-muted/30 p-4">
                            <summary className="cursor-pointer text-sm font-semibold text-foreground">{t("tokens.claudeWeb")}</summary>
                            <p className="mt-3 text-xs leading-5 text-muted-foreground">
                                {t("tokens.claudeWebBody")}
                            </p>
                            <p className="mt-2 text-xs leading-5 text-amber-300/80">
                                {t("tokens.claudeWebHttps")}
                            </p>
                        </details>
                    </div>
                </section>
            )}

            {activeTab === "displays" && isAdmin && (
                <DisplaysTab
                    tokens={tokens}
                    onTokenCreated={(token) => setTokens((prev) => [{ expiresAt: "", ...token }, ...prev])}
                    onTokenRemoved={(id) => setTokens((prev) => prev.filter((token) => token.id !== id))}
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
                            <IconPlugConnected className="mr-2 h-5 w-5 text-primary" /> {t("advanced.title")}
                        </h2>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            {t("advanced.intro")}
                        </p>
                        <details className="mt-5 rounded-2xl border border-border bg-muted/30 p-4">
                            <summary className="cursor-pointer text-sm font-semibold text-foreground">{t("advanced.showCommands")}</summary>
                            <div className="mt-4 space-y-3 rounded-xl border border-border bg-background p-4">
                                {OPENCLAW_COMMANDS.map((command) => <code key={command} className="block whitespace-pre-wrap font-mono text-sm text-foreground">{command}</code>)}
                            </div>
                        </details>
                        <details className="mt-3 rounded-2xl border border-border bg-muted/30 p-4">
                            <summary className="cursor-pointer text-sm font-semibold text-foreground">{t("advanced.showScopes")}</summary>
                            <p className="mt-3 text-sm leading-6 text-muted-foreground">
                                {t("advanced.scopesBody")}
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

function InstanceSettingsTab() {
    const t = useTranslations("settings.instance");
    const tc = useTranslations("common");
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
                toast.success(newMode === "open" ? t("nowOpen") : t("nowInviteOnly"));
            } else {
                toast.error(t("modeFailed"));
            }
        } catch {
            toast.error(t("modeFailed"));
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
                toast.success(t("nameUpdated"));
            } else {
                toast.error(t("nameFailed"));
            }
        } catch {
            toast.error(t("nameFailed"));
        } finally {
            setSavingName(false);
        }
    };

    return (
        <section className="space-y-4">
            <div className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6">
                <h2 className="flex items-center text-lg font-semibold text-foreground">
                    <IconSettings className="mr-2 h-5 w-5 text-primary" /> {t("title")}
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {t("intro")}
                </p>

                <div className="mt-6 space-y-4">
                    <div className="flex items-center justify-between rounded-xl border border-border bg-muted/30 p-4">
                        <div>
                            <h3 className="font-medium text-foreground">{t("registrationMode")}</h3>
                            <p className="mt-1 text-sm text-muted-foreground">
                                {registrationMode === "open"
                                    ? t("openHint")
                                    : t("inviteOnlyHint")}
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
                            {saving ? tc("saving") : registrationMode === "open" ? t("open") : t("inviteOnly")}
                        </Button>
                    </div>

                    <div className="rounded-xl border border-border bg-muted/30 p-4">
                        <h3 className="font-medium text-foreground">{t("name")}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">{t("nameHint")}</p>
                        <div className="mt-3 flex gap-2">
                            <Input
                                type="text"
                                placeholder={t("namePlaceholder")}
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
                                {savingName ? tc("saving") : tc("save")}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}

function CopyPromptButton({ text }: { text: string }) {
    const t = useTranslations("settings.connections");
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        toast.success(t("promptCopied"));
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <button
            type="button"
            onClick={handleCopy}
            className="cursor-pointer rounded-lg border border-emerald-500/30 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/15 transition-colors flex items-center gap-1.5"
        >
            {copied ? <IconCircleCheck className="h-3.5 w-3.5" /> : <IconCopy className="h-3.5 w-3.5" />}
            {copied ? t("copiedPrompt") : t("copyPrompt")}
        </button>
    );
}
