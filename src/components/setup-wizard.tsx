"use client";

import Link from "next/link";
import { createClientRequestId } from "@/lib/client-request-id";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
    IconArrowLeft, IconArrowRight, IconBook2, IconBuilding, IconCheck, IconCircleCheck, IconCpu,
    IconExternalLink, IconKey, IconLoader2, IconMessage, IconRocket, IconSparkles, IconUsersGroup, IconAlertTriangle, IconX,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { HermesImageProgress } from "@/components/hermes-image-progress";
import { SampleClientOffer } from "@/components/sample-client";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Input } from "@/components/ui/input";
import { agentRoleTemplates, getAgentTemplate } from "@/lib/agent-templates";
import { BUSINESS_TYPES, COMFORTABLE_AGENT_COUNT, DEFAULT_AGENT_NAMES, MAX_WIZARD_AGENTS, TEAM_TEMPLATES, planTeam, suggestedTeams, teamPlanProblemKind, type PlannedGroup } from "@/lib/onboarding-shared";
import { cn } from "@/lib/utils";
import { CUSTOM_LLM_PROVIDER, normalizeLlmBaseUrl } from "@/lib/llm-endpoint";
import { COMPANY_TEMPLATES, DEFAULT_COMPANY_TEMPLATE, type CompanyTemplateId } from "@/lib/modules";

/**
 * First-run setup, modelled on an OS setup assistant: one focused screen per
 * decision, a step rail showing where you are, and nothing else on screen.
 * Company → AI model (a key is required: without it no agent can answer) →
 * team → launch, where the lead agent's first job is documenting the company
 * in Knowledge & Rules while you watch.
 */

type Step = "welcome" | "company" | "model" | "team" | "launch";
type KeyState = { status: "idle" | "checking" | "ok" | "bad" | "unknown"; message: string };
type Member = { templateId: string; name: string };
type Created = { name: string; agentId: string | null; success: boolean; message: string; templateId: string; reused?: boolean };
type AgentRow = { id: string; name: string; status: string; lastSeenAt: string | null; role?: string | null; createdAt?: string };
type DocProgress = { taskId: string; state: string; agentId: string | null; taskUrl: string; notesTouched: string[]; totalNotes: number };

// Provider names are brands (never translated); the custom endpoint's label and the hints are messages.
const PROVIDERS = [
    { id: "openrouter", copy: "openrouter", label: "OpenRouter", keyUrl: "https://openrouter.ai/keys", defaultModel: "nvidia/nemotron-3-ultra-550b-a55b:free" },
    { id: "deepseek", copy: "deepseek", label: "DeepSeek", keyUrl: "https://platform.deepseek.com/api_keys", defaultModel: "" },
    { id: CUSTOM_LLM_PROVIDER, copy: "custom", label: null, keyUrl: "", defaultModel: "" },
] as const;

const STEPS: { id: Step; icon: typeof IconBuilding }[] = [
    { id: "welcome", icon: IconSparkles },
    { id: "company", icon: IconBuilding },
    { id: "model", icon: IconCpu },
    { id: "team", icon: IconUsersGroup },
    { id: "launch", icon: IconRocket },
];

const STARTUP_GRACE_MS = 3 * 60 * 1000;
/** Technical examples shown as placeholders: a URL and API key prefixes, never translated. */
const CUSTOM_BASE_URL_EXAMPLE = "http://host.docker.internal:11434/v1";
const KEY_PREFIX_HINTS = { openrouter: "sk-or-v1-…", other: "sk-…" };

export function SetupWizard({ initialCompanyName, initialBusinessType = "", profileComplete, hasAgents: hasAgentsNow, offerSampleClient = false }: { initialCompanyName: string; initialBusinessType?: string; profileComplete: boolean; hasAgents: boolean; offerSampleClient?: boolean }) {
    const t = useTranslations("onboarding.wizard");
    const tBusiness = useTranslations("onboarding.businessTypes");
    const tTeams = useTranslations("agents.easySetup.teams");
    const tTemplates = useTranslations("settings.modules.templates");
    const tSetup = useTranslations("agents.easySetup");
    const router = useRouter();
    // The mode is fixed when the wizard opens. The launch saves agents before
    // their runtimes start, and the dashboard refreshes every few seconds: a
    // live `hasAgents` flipped a running launch into the profile-only flow.
    // Agents but no profile: only the company step. Agents and a profile: a
    // launch that was interrupted (reload), resumed on the launch step.
    const [hasAgents] = useState(hasAgentsNow && !profileComplete);
    const [resumingLaunch] = useState(hasAgentsNow && profileComplete);
    const [step, setStep] = useState<Step>(resumingLaunch ? "launch" : "welcome");
    const [hidden, setHidden] = useState(false);
    const [showSampleOffer] = useState(offerSampleClient);
    const [error, setError] = useState("");

    // Company
    const [companyName, setCompanyName] = useState(initialCompanyName);
    // The name given at sign-up is shown, not asked again; "Change" edits it.
    const [editingName, setEditingName] = useState(initialCompanyName.trim().length < 2);
    const [whatYouDo, setWhatYouDo] = useState("");
    const [businessType, setBusinessType] = useState<string>(initialBusinessType);
    const [website, setWebsite] = useState("");
    const [houseRules, setHouseRules] = useState("");
    const [documentIt, setDocumentIt] = useState(true);
    // Which modules the company starts with (Settings → Modules); Agency = everything on.
    const [template, setTemplate] = useState<CompanyTemplateId>(DEFAULT_COMPANY_TEMPLATE);
    const [savingProfile, setSavingProfile] = useState(false);

    // Model
    const [available, setAvailable] = useState<boolean | null>(null);
    const [unavailableReason, setUnavailableReason] = useState("");
    const [provider, setProvider] = useState<string>(PROVIDERS[0].id);
    const [apiKey, setApiKey] = useState("");
    const [model, setModel] = useState<string>(PROVIDERS[0].defaultModel);
    const [baseUrl, setBaseUrl] = useState("");
    const [showModel, setShowModel] = useState(false);
    const [keyState, setKeyState] = useState<KeyState>({ status: "idle", message: "" });

    // Team: choose team templates (any mix), then confirm names.
    const [teams, setTeams] = useState<string[]>(() => suggestedTeams(initialBusinessType));
    const [includeBoss, setIncludeBoss] = useState(true);
    const [extraRoles, setExtraRoles] = useState<string[]>([]);
    const [removedRoles, setRemovedRoles] = useState<string[]>([]);
    const [names, setNames] = useState<Record<string, string>>({});
    const teamTouched = useRef(false);
    const plan = useMemo(() => planTeam({ teams, includeBoss, extraRoles, removedRoles, names }), [teams, includeBoss, extraRoles, removedRoles, names]);
    const team: Member[] = plan.agents;
    const hiringRequestIds = useRef(new Map<string, string>());
    const groupRequestIds = useRef(new Map<string, string>());
    const [groupBusy, setGroupBusy] = useState(false);
    const [groupsMade, setGroupsMade] = useState<{ title: string; icon: string; ok: boolean; members: string[] }[]>([]);

    // Launch
    const [launching, setLaunching] = useState(false);
    const [created, setCreated] = useState<Created[] | null>(null);
    const [roster, setRoster] = useState<AgentRow[]>([]);
    const [launchedAt, setLaunchedAt] = useState<number | null>(null);
    const [retrying, setRetrying] = useState<string | null>(null);
    const [doc, setDoc] = useState<DocProgress | null>(null);
    const docStarted = useRef(false);
    const [, setTick] = useState(0);

    const providerInfo = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
    const providerLabel = (p: (typeof PROVIDERS)[number]) => p.label ?? tSetup("customEndpoint");
    const customEndpoint = provider === CUSTOM_LLM_PROVIDER;
    const baseUrlCheck = customEndpoint && baseUrl.trim() ? normalizeLlmBaseUrl(baseUrl) : null;
    // A custom endpoint needs its URL and model; the key is optional (local servers have none).
    const modelReady = customEndpoint ? Boolean(baseUrlCheck?.ok) && Boolean(model.trim()) : Boolean(apiKey.trim());
    const stepIndex = STEPS.findIndex((s) => s.id === step);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch("/api/agents/easy-setup", { cache: "no-store" });
                const data = await res.json();
                if (cancelled) return;
                setAvailable(Boolean(data.available));
                setUnavailableReason(data.reason || "");
            } catch {
                if (!cancelled) { setAvailable(false); setUnavailableReason(t("availabilityCheckFailed")); }
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Resuming a launch after a reload: the agents already exist, so watch them
    // come online (with Retry) and hand the lead its first job, as before.
    useEffect(() => {
        if (!resumingLaunch) return;
        let cancelled = false;
        void (async () => {
            const data = await fetch("/api/agents", { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { agents?: AgentRow[] } | null;
            if (cancelled || !data?.agents?.length) return;
            const rows = data.agents.map((a) => ({ ...a, templateId: agentRoleTemplates.find((t) => t.title === a.role)?.id ?? a.role ?? "" }))
                .sort((a, b) => (a.templateId === "boss" ? -1 : b.templateId === "boss" ? 1 : (a.createdAt ?? "").localeCompare(b.createdAt ?? "")));
            setRoster(data.agents);
            setCreated(rows.map((a) => ({ name: a.name, agentId: a.id, success: true, message: "", templateId: a.templateId })));
            setLaunchedAt(Math.min(...rows.map((a) => (a.createdAt ? Date.parse(a.createdAt) : Date.now()))));
        })();
        return () => { cancelled = true; };
    }, [resumingLaunch]);

    // Suggest teams for the kind of company, until the operator edits them.
    useEffect(() => {
        if (teamTouched.current || !businessType) return;
        setTeams(suggestedTeams(businessType));
    }, [businessType]);

    const finish = useCallback(async (status: "completed" | "dismissed") => {
        await fetch("/api/onboarding", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }).catch(() => null);
    }, []);

    const setUpLater = async () => {
        await finish("dismissed");
        setHidden(true);
        router.refresh();
    };

    // ── Company ──────────────────────────────────────────────────────────────
    const companyValid = companyName.trim().length >= 2 && whatYouDo.trim().length >= 10;
    const saveCompany = async () => {
        setSavingProfile(true);
        setError("");
        try {
            const res = await fetch("/api/onboarding/profile", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ companyName, whatYouDo, businessType, website, houseRules }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || t("saveCompanyFailed"));
            if (!hasAgents) {
                // A template only sets the starting modules; it changes nothing else.
                const applied = await fetch("/api/settings/modules", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template }) });
                if (!applied.ok) throw new Error((await applied.json().catch(() => ({}))).error || t("saveModulesFailed"));
            }
            if (hasAgents) {
                await finish("completed");
                setHidden(true);
                router.refresh();
                return;
            }
            setStep("model");
        } catch (e) {
            setError(e instanceof Error ? e.message : t("saveCompanyFailed"));
        } finally {
            setSavingProfile(false);
        }
    };

    // ── Model ────────────────────────────────────────────────────────────────
    const checkKey = async () => {
        if (keyState.status === "unknown") { setStep("team"); return; } // second click: continue anyway
        setKeyState({ status: "checking", message: "" });
        try {
            const res = await fetch("/api/onboarding/validate-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, apiKey, ...(customEndpoint ? { baseUrl, model } : {}) }) });
            const data = await res.json();
            if (data.ok === true) { setKeyState({ status: "ok", message: data.detail || t("keyWorks") }); setStep("team"); }
            else if (data.ok === false) setKeyState({ status: "bad", message: data.error });
            else setKeyState({ status: "unknown", message: data.error || t("keyCheckFailed") });
        } catch {
            setKeyState({ status: "unknown", message: t("keyCheckUnreachable") });
        }
    };

    // ── Team ─────────────────────────────────────────────────────────────────
    const touch = () => { teamTouched.current = true; };
    const toggleTeam = (id: string) => {
        touch();
        setTeams((current) => (current.includes(id) ? current.filter((t) => t !== id) : [...current, id]));
        // Choosing a team brings back any of its roles you had removed.
        const roles = TEAM_TEMPLATES.find((t) => t.id === id)?.roles ?? [];
        setRemovedRoles((current) => current.filter((r) => !(roles as readonly string[]).includes(r)));
    };
    const removeRole = (role: string) => {
        touch();
        if (role === "boss") setIncludeBoss(false);
        setExtraRoles((current) => current.filter((r) => r !== role));
        setRemovedRoles((current) => (current.includes(role) ? current : [...current, role]));
    };
    const addRole = (role: string) => {
        if (!role) return;
        touch();
        if (role === "boss") setIncludeBoss(true);
        setRemovedRoles((current) => current.filter((r) => r !== role));
        setExtraRoles((current) => (current.includes(role) ? current : [...current, role]));
    };
    const renameMember = (templateId: string, name: string) => setNames((current) => ({ ...current, [templateId]: name }));
    const planProblemKind = teamPlanProblemKind(plan);
    const planProblem = planProblemKind ? t(`planProblems.${planProblemKind}`, { max: MAX_WIZARD_AGENTS }) : null;
    const teamValid = !planProblem;
    const addable = agentRoleTemplates.filter((t) => !team.some((m) => m.templateId === t.id));

    // ── Launch ───────────────────────────────────────────────────────────────
    const launch = async () => {
        if (launching) return;
        setStep("launch");
        setLaunching(true);
        setError("");
        try {
            // The lead goes first: it gets the documentation job.
            const ordered = [...team].sort((a, b) => (a.templateId === "boss" ? -1 : b.templateId === "boss" ? 1 : 0));
            const previousByRole = new Map((created ?? []).filter(result => result.agentId).map(result => [result.templateId, result]));
            const requested = ordered.filter(member => !previousByRole.has(member.templateId));
            const res = requested.length ? await fetch("/api/agents/easy-setup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sourceAgentId: created?.find(result => result.agentId)?.agentId || undefined,
                    llmProvider: provider,
                    llmApiKey: apiKey,
                    llmModel: model.trim() || undefined,
                    llmBaseUrl: customEndpoint ? baseUrl.trim() : undefined,
                    agents: requested.map((m) => {
                        const t = getAgentTemplate(m.templateId);
                        if (!hiringRequestIds.current.has(m.templateId)) hiringRequestIds.current.set(m.templateId, createClientRequestId());
                        return {
                            requestId: hiringRequestIds.current.get(m.templateId),
                            name: m.name.trim(),
                            role: t?.title ?? m.templateId,
                            doctrineJson: t ? { "SOUL.md": t.soul, "AGENTS.md": t.agents, "BOOTSTRAP.md": t.bootstrap, "IDENTITY.md": t.identity } : {},
                        };
                    }),
                }),
            }) : null;
            const data = res ? await res.json().catch(() => ({})) : { results: [] };
            if (res && !res.ok) throw new Error(data.error || t("createAgentsFailed"));
            const returnedByRole = new Map<string, Created>(requested.map((member, index) => [member.templateId, {
                ...(data.results?.[index] ?? { name: member.name, agentId: null, success: false, message: t("noResult") }), templateId: member.templateId,
            }]));
            const results = ordered.map(member => previousByRole.get(member.templateId) ?? returnedByRole.get(member.templateId)!);
            setCreated(results);
            setLaunchedAt(Date.now());
            if (results.some((r) => r.success && r.agentId)) setApiKey("");
            await createGroups(plan.groups, results);
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : t("createAgentsFailed"));
        } finally {
            setLaunching(false);
        }
    };

    // One group chat per chosen team, with its agents and the Boss; you are
    // added as its creator. A failed group never blocks the agents.
    const createGroups = async (groups: PlannedGroup[], results: Created[]) => {
        if (groupBusy) return;
        setGroupBusy(true);
        try {
            const byRole = new Map(results.filter(result => result.agentId).map(result => [result.templateId, result]));
            const teamIds: string[] = [];
            const made: { title: string; icon: string; ok: boolean; members: string[] }[] = [];
            for (const group of groups) {
                const members = group.roles.map(role => byRole.get(role)).filter((member): member is Created => Boolean(member));
                if (members.length !== group.roles.length) {
                    made.push({ title: group.title, icon: group.icon, ok: false, members: members.map(member => member.name) });
                    continue;
                }
                const coordinatorId = members.find(member => member.templateId !== "boss")?.agentId;
                if (!coordinatorId) continue;
                if (!groupRequestIds.current.has(group.teamId)) groupRequestIds.current.set(group.teamId, createClientRequestId());
                const response = await fetch("/api/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
                    requestId: groupRequestIds.current.get(group.teamId), title: group.title, description: group.description, icon: group.icon,
                    agentIds: members.map(member => member.agentId), coordinator: { kind: "agent", id: coordinatorId },
                }) }).catch(() => null);
                const data = response?.ok ? await response.json().catch(() => null) : null;
                if (data?.group?.id) teamIds.push(data.group.id);
                made.push({ title: group.title, icon: group.icon, ok: Boolean(data?.group?.id), members: members.map(member => member.name) });
            }
            if (teamIds.length && teamIds.length === groups.length) {
                const leaderId = byRole.get("boss")?.agentId ?? results.find(result => result.agentId)?.agentId;
                const response = await fetch("/api/organization", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initialize: true, leader: leaderId ? { kind: "agent", id: leaderId } : null, teamIds }) }).catch(() => null);
                if (!response?.ok && response?.status !== 409) setError(t("reportingRetry"));
            }
            setGroupsMade(made);
        } finally {
            setGroupBusy(false);
        }
    };

    // Watch the new agents come online, and the documentation job.
    useEffect(() => {
        if (step !== "launch" || !created) return;
        let cancelled = false;
        const poll = async () => {
            try {
                const res = await fetch("/api/agents", { cache: "no-store" });
                const data = await res.json();
                if (!cancelled) setRoster(data.agents || []);
                if (doc?.taskId) {
                    const p = await fetch(`/api/onboarding/document?taskId=${doc.taskId}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
                    if (!cancelled && p?.progress) setDoc(p.progress);
                }
            } catch { /* keep polling */ }
            if (!cancelled) setTick((t) => t + 1);
        };
        void poll();
        const id = window.setInterval(poll, 4000);
        return () => { cancelled = true; window.clearInterval(id); };
    }, [step, created, doc?.taskId]);

    const isOnline = (agentId: string | null) => {
        const row = roster.find((a) => a.id === agentId);
        return row?.status === "online" && Boolean(row.lastSeenAt);
    };
    const lead = created?.find((r) => r.agentId) ?? null;
    const online = Boolean(lead && isOnline(lead.agentId));
    const offlineTooLong = Boolean(launchedAt && Date.now() - launchedAt > STARTUP_GRACE_MS);

    useEffect(() => {
        if (!online || !lead?.agentId || !documentIt || docStarted.current) return;
        docStarted.current = true;
        void (async () => {
            const res = await fetch("/api/onboarding/document", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: lead.agentId, website }) });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.progress) setDoc(data.progress);
            else docStarted.current = false;
        })();
    }, [online, lead?.agentId, documentIt, website]);

    const retryRuntime = async (agentId: string) => {
        setRetrying(agentId);
        try {
            const response = await fetch(`/api/agents/${agentId}/recreate-runtime`, { method: "POST" });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.success) throw new Error(data.error || data.message || t("restartFailed"));
            setCreated(previous => previous?.map(result => result.agentId === agentId ? { ...result, success: true, message: data.message } : result) ?? null);
            setLaunchedAt(Date.now());
        } catch (error) {
            setError(error instanceof Error ? error.message : t("restartFailed"));
        } finally {
            setRetrying(null);
        }
    };

    const openDirectChat = async () => {
        if (!lead?.agentId) return;
        await finish("completed");
        router.push(`/messages?agent=${lead.agentId}`);
    };
    const goToDashboard = async () => {
        await finish("completed");
        setHidden(true);
        router.refresh();
    };

    const docLabel = useMemo(() => {
        if (!lead) return "";
        if (!doc) return online ? t("doc.handingOver") : t("doc.startsWhenOnline", { name: lead.name });
        if (doc.state === "done") return t("doc.done", { count: doc.notesTouched.length });
        if (doc.state === "inbox") return t("doc.waiting", { name: lead.name });
        return doc.notesTouched.length ? t("doc.writing", { notes: doc.notesTouched.slice(0, 4).join(", ") }) : t("doc.reading", { name: lead.name });
    }, [doc, lead, online, t]);

    if (hidden) return null;

    const stepsShown = hasAgents ? STEPS.filter((s) => s.id === "welcome" || s.id === "company") : STEPS;

    return (
        <div role="dialog" aria-modal="true" aria-labelledby="setup-title" className="fixed inset-0 z-[200] flex items-center justify-center bg-background/80 p-0 backdrop-blur-md sm:p-6">
            <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden border-border bg-background shadow-2xl sm:h-[min(760px,100%)] sm:flex-row sm:rounded-3xl sm:border">
                {/* Step rail */}
                <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-muted/20 p-6 sm:flex">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700 dark:text-cyan-300">{t("railTitle")}</p>
                    <ol className="mt-8 space-y-1">
                        {stepsShown.map((s, i) => {
                            const done = i < stepIndex;
                            const current = s.id === step;
                            const Icon = s.icon;
                            return (
                                <li key={s.id} className={cn("flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm", current ? "bg-cyan-400/10 text-foreground" : done ? "text-muted-foreground" : "text-muted-foreground")}>
                                    <span className={cn("flex h-7 w-7 items-center justify-center rounded-full ring-1", current ? "bg-cyan-400/20 text-cyan-800 dark:text-cyan-200 ring-cyan-400/40" : done ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30" : "ring-border")}>
                                        {done ? <IconCheck className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                                    </span>
                                    {t(`steps.${s.id}`)}
                                </li>
                            );
                        })}
                    </ol>
                    <button type="button" onClick={() => void setUpLater()} className="mt-auto min-h-11 text-left text-xs text-muted-foreground underline-offset-2 hover:text-muted-foreground hover:underline">
                        {t("setUpLater")}
                    </button>
                </aside>

                <main className="flex min-h-0 flex-1 flex-col">
                    {/* Mobile progress */}
                    <div className="flex items-center justify-between border-b border-border px-5 py-3 sm:hidden">
                        <span className="text-xs text-muted-foreground">{t("stepOf", { step: stepIndex + 1, total: stepsShown.length, label: t(`steps.${STEPS[stepIndex].id}`) })}</span>
                        <button type="button" onClick={() => void setUpLater()} className="text-xs text-muted-foreground underline">{t("later")}</button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-8 sm:px-12 sm:py-12">
                        {error && <p role="alert" className="mb-6 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-200"><IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}

                        {step === "welcome" && (
                            <section className="mx-auto flex max-w-xl flex-col items-center pt-6 text-center">
                                <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-cyan-400/25 to-violet-500/20 ring-1 ring-border">
                                    <IconSparkles className="h-10 w-10 text-cyan-800 dark:text-cyan-200" />
                                </div>
                                <h1 id="setup-title" className="mt-8 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{t("welcome.title")}</h1>
                                <p className="mt-4 text-base leading-7 text-muted-foreground">
                                    {hasAgents || profileComplete
                                        ? hasAgents ? t("welcome.introProfileOnly") : t("welcome.introProfileDone")
                                        : t("welcome.intro")}
                                </p>
                                <ul className="mt-8 grid w-full gap-3 text-left text-sm sm:grid-cols-3">
                                    {[
                                        { icon: IconBuilding, title: t("welcome.companyTitle"), body: t("welcome.companyBody") },
                                        { icon: IconUsersGroup, title: t("welcome.teamsTitle"), body: t("welcome.teamsBody") },
                                        { icon: IconBook2, title: t("welcome.documentedTitle"), body: t("welcome.documentedBody") },
                                    ].map(({ icon: Icon, title, body }) => (
                                        <li key={title} className="rounded-2xl border border-border bg-muted/30 p-4">
                                            <Icon className="h-5 w-5 text-cyan-700 dark:text-cyan-300" />
                                            <p className="mt-3 font-medium text-foreground">{title}</p>
                                            <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p>
                                        </li>
                                    ))}
                                </ul>
                                {/* Owners/admins of a workspace with no customers yet (decided on the server). */}
                                {showSampleOffer && <div className="mt-6 w-full"><SampleClientOffer /></div>}
                            </section>
                        )}

                        {step === "company" && (
                            <section className="mx-auto max-w-2xl space-y-6">
                                <header>
                                    <h1 id="setup-title" className="text-2xl font-semibold text-foreground">{t("company.title")}</h1>
                                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("company.intro")}</p>
                                </header>
                                {editingName ? (
                                    <label className="block space-y-2">
                                        <span className="text-sm font-medium text-foreground">{t("company.nameLabel")}</span>
                                        <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder={t("company.namePlaceholder")} autoFocus />
                                    </label>
                                ) : (
                                    <p className="flex flex-wrap items-baseline gap-2 text-sm text-muted-foreground">
                                        {t("company.company")} <span className="text-base font-medium text-foreground">{companyName}</span>
                                        <button type="button" onClick={() => setEditingName(true)} className="min-h-11 text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">{t("company.change")}</button>
                                    </p>
                                )}
                                <label className="block space-y-2">
                                    <span className="text-sm font-medium text-foreground">{t("company.whatLabel")}</span>
                                    <textarea value={whatYouDo} onChange={(e) => setWhatYouDo(e.target.value)} rows={3} autoFocus={!editingName} placeholder={t("company.whatPlaceholder")}
                                        className="w-full resize-y rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20" />
                                </label>
                                <fieldset className="space-y-2">
                                    <legend className="text-sm font-medium text-foreground">{t("company.kindLabel")}</legend>
                                    <div className="grid gap-2 sm:grid-cols-3">
                                        {BUSINESS_TYPES.map((type) => (
                                            <button key={type.id} type="button" aria-pressed={businessType === type.id} onClick={() => setBusinessType(type.id)}
                                                className={cn("rounded-xl border p-3 text-left transition-colors", businessType === type.id ? "border-cyan-400/50 bg-cyan-400/10" : "border-border bg-muted/20 hover:border-input")}>
                                                <span className="block text-sm font-medium text-foreground">{tBusiness(`${type.id}.label`)}</span>
                                                <span className="mt-0.5 block text-xs text-muted-foreground">{tBusiness(`${type.id}.hint`)}</span>
                                            </button>
                                        ))}
                                    </div>
                                </fieldset>
                                {!hasAgents && (
                                    <fieldset className="space-y-2">
                                        <legend className="text-sm font-medium text-foreground">{t("company.useLabel")}</legend>
                                        <div className="grid gap-2 sm:grid-cols-3">
                                            {COMPANY_TEMPLATES.map((option) => (
                                                <button key={option.id} type="button" aria-pressed={template === option.id} onClick={() => setTemplate(option.id)}
                                                    className={cn("rounded-xl border p-3 text-left transition-colors", template === option.id ? "border-cyan-400/50 bg-cyan-400/10" : "border-border bg-muted/20 hover:border-input")}>
                                                    <span className="block text-sm font-medium text-foreground">{tTemplates(`${option.id}.label`)}</span>
                                                    <span className="mt-0.5 block text-xs text-muted-foreground">{tTemplates(`${option.id}.description`)}</span>
                                                </button>
                                            ))}
                                        </div>
                                        <p className="text-xs text-muted-foreground">{t("company.useHint")}</p>
                                    </fieldset>
                                )}
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <label className="block space-y-2">
                                        <span className="text-sm font-medium text-foreground">{t("company.website")} <span className="font-normal text-muted-foreground">{t("optional")}</span></span>
                                        <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder={t("company.websitePlaceholder")} type="url" />
                                    </label>
                                    <label className="block space-y-2">
                                        <span className="text-sm font-medium text-foreground">{t("company.houseRules")} <span className="font-normal text-muted-foreground">{t("company.houseRulesHint")}</span></span>
                                        <textarea value={houseRules} onChange={(e) => setHouseRules(e.target.value)} rows={2} placeholder={t("company.houseRulesPlaceholder")}
                                            className="w-full resize-y rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20" />
                                    </label>
                                </div>
                                {!hasAgents && (
                                    <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.05] p-4">
                                        <input type="checkbox" checked={documentIt} onChange={(e) => setDocumentIt(e.target.checked)} className="mt-1 h-4 w-4 accent-cyan-400" />
                                        <span>
                                            <span className="flex items-center gap-2 text-sm font-medium text-foreground"><IconBook2 className="h-4 w-4 text-cyan-700 dark:text-cyan-300" />{t("company.documentIt")}</span>
                                            <span className="mt-1 block text-xs leading-5 text-muted-foreground">{t("company.documentItHint", { website: website ? "yes" : "no" })}</span>
                                        </span>
                                    </label>
                                )}
                            </section>
                        )}

                        {step === "model" && (
                            <section className="mx-auto max-w-2xl space-y-6">
                                <header>
                                    <h1 id="setup-title" className="text-2xl font-semibold text-foreground">{t("model.title")}</h1>
                                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("model.intro")}</p>
                                </header>
                                {available === false ? (
                                    <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-5 text-sm text-amber-900 dark:text-amber-100">
                                        <p className="font-medium">{t("model.unavailableTitle")}</p>
                                        <p className="mt-1 text-amber-900 dark:text-amber-100/80">{unavailableReason}</p>
                                        <p className="mt-3 text-amber-900 dark:text-amber-100/80">{t("model.unavailableHint")}</p>
                                        <div className="mt-4 flex flex-wrap gap-3">
                                            <Link href="/docs/v1.1/hermes-runtime" className="inline-flex items-center gap-1 text-cyan-700 dark:text-cyan-300 underline">{t("model.connectHermes")} <IconExternalLink className="h-3.5 w-3.5" /></Link>
                                            <Link href="/docs/v1.1/installation" className="inline-flex items-center gap-1 text-cyan-700 dark:text-cyan-300 underline">{t("model.dockerGuide")} <IconExternalLink className="h-3.5 w-3.5" /></Link>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <div className="grid gap-3 sm:grid-cols-3">
                                            {PROVIDERS.map((p) => (
                                                <button key={p.id} type="button" aria-pressed={provider === p.id}
                                                    onClick={() => { setProvider(p.id); setModel(p.defaultModel); setKeyState({ status: "idle", message: "" }); }}
                                                    className={cn("rounded-2xl border p-4 text-left transition-colors", provider === p.id ? "border-cyan-400/50 bg-cyan-400/10" : "border-border bg-muted/20 hover:border-input")}>
                                                    <span className="flex items-center justify-between text-sm font-medium text-foreground">{providerLabel(p)}{p.id === "openrouter" && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">{t("model.recommended")}</span>}</span>
                                                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">{t(`model.providerHints.${p.copy}`)}</span>
                                                </button>
                                            ))}
                                        </div>
                                        {customEndpoint && (
                                            <div className="grid gap-4 sm:grid-cols-2">
                                                <label className="block space-y-2">
                                                    <span className="text-sm font-medium text-foreground">{tSetup("baseUrl")}</span>
                                                    <Input type="url" autoComplete="off" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setKeyState({ status: "idle", message: "" }); }} placeholder={CUSTOM_BASE_URL_EXAMPLE} aria-invalid={baseUrlCheck?.ok === false} />
                                                </label>
                                                <label className="block space-y-2">
                                                    <span className="text-sm font-medium text-foreground">{tSetup("model")}</span>
                                                    <Input value={model} onChange={(e) => { setModel(e.target.value); setKeyState({ status: "idle", message: "" }); }} placeholder={tSetup("customModelPlaceholder")} />
                                                </label>
                                                {baseUrlCheck?.ok === false
                                                    ? <p role="alert" className="text-xs text-rose-700 dark:text-rose-300 sm:col-span-2">{baseUrlCheck.error}</p>
                                                    : <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">{baseUrlCheck?.ok && baseUrlCheck.hint ? baseUrlCheck.hint : t("model.localhostHint")}</p>}
                                            </div>
                                        )}
                                        <label className="block space-y-2">
                                            <span className="flex items-center justify-between text-sm font-medium text-foreground">
                                                <span className="flex items-center gap-2"><IconKey className="h-4 w-4 text-cyan-700 dark:text-cyan-300" />{customEndpoint ? <>{t("model.apiKey")} <span className="font-normal text-muted-foreground">{t("optional")}</span></> : t("model.providerApiKey", { provider: providerLabel(providerInfo) })}</span>
                                                {providerInfo.keyUrl && <a href={providerInfo.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-normal text-cyan-700 dark:text-cyan-300 hover:underline">{t("model.getKey")} <IconExternalLink className="h-3 w-3" /></a>}
                                            </span>
                                            <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setKeyState({ status: "idle", message: "" }); }} placeholder={customEndpoint ? tSetup("keyOptionalPlaceholder") : provider === "openrouter" ? KEY_PREFIX_HINTS.openrouter : KEY_PREFIX_HINTS.other} aria-invalid={keyState.status === "bad"} />
                                            {keyState.status === "ok" && <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-300"><IconCircleCheck className="h-3.5 w-3.5" />{keyState.message}</p>}
                                            {keyState.status === "bad" && <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{keyState.message}</p>}
                                            {keyState.status === "unknown" && <p className="text-xs text-amber-800 dark:text-amber-200">{keyState.message} {t("model.continueAgain")}</p>}
                                        </label>
                                        {provider === "openrouter" && (
                                            <p className="rounded-xl border border-border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">
                                                {t.rich("model.freeModel", { strong: (chunks) => <strong className="text-foreground">{chunks}</strong> })}
                                            </p>
                                        )}
                                        {!customEndpoint && <div>
                                            <button type="button" onClick={() => setShowModel((v) => !v)} className="text-xs text-muted-foreground underline-offset-2 hover:text-muted-foreground hover:underline">{showModel ? t("model.hideModel") : t("model.chooseModel")}</button>
                                            {showModel && (
                                                <Input className="mt-2" value={model} onChange={(e) => setModel(e.target.value)} placeholder={t("model.modelExample", { model: provider === "openrouter" ? "anthropic/claude-sonnet-5-5" : "deepseek-chat" })} aria-label={tSetup("model")} />
                                            )}
                                        </div>}
                                    </>
                                )}
                            </section>
                        )}

                        {step === "team" && (
                            <section className="mx-auto max-w-2xl space-y-6">
                                <header>
                                    <h1 id="setup-title" className="text-2xl font-semibold text-foreground">{t("team.title")}</h1>
                                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                                        {businessType && businessType !== "other" ? `${t("team.suggested")} ` : ""}{t("team.intro")}
                                    </p>
                                </header>
                                <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={t("team.templatesLabel")}>
                                    {TEAM_TEMPLATES.map((teamTemplate) => {
                                        const on = teams.includes(teamTemplate.id);
                                        return (
                                            <button key={teamTemplate.id} type="button" aria-pressed={on} onClick={() => toggleTeam(teamTemplate.id)}
                                                className={cn("flex items-start gap-3 rounded-2xl border p-3 text-left transition-colors", on ? "border-cyan-400/50 bg-cyan-400/10" : "border-border bg-muted/20 hover:border-input")}>
                                                <span className="text-xl leading-none" aria-hidden>{teamTemplate.icon}</span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="flex items-center justify-between gap-2 text-sm font-medium text-foreground">
                                                        {tTeams(`${teamTemplate.id}.label`)}
                                                        <span className={cn("grid h-4 w-4 shrink-0 place-items-center rounded border", on ? "border-cyan-400 bg-cyan-400 text-primary-foreground" : "border-input")}>{on && <IconCheck className="h-3 w-3" />}</span>
                                                    </span>
                                                    <span className="mt-0.5 block text-xs text-muted-foreground">{tTeams(`${teamTemplate.id}.hint`)}</span>
                                                    <span className="mt-1 block text-xs text-muted-foreground">{teamTemplate.roles.map((r) => getAgentTemplate(r)?.title ?? r).join(" · ")}</span>
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>

                                <div>
                                    <div className="mb-2 flex items-center justify-between">
                                        <h2 className="text-sm font-medium text-foreground">{t("team.yourAgents")} <span className="font-normal text-muted-foreground">({team.length})</span></h2>
                                        <select aria-label={t("team.addSpecialist")} value="" onChange={(e) => addRole(e.target.value)}
                                            className="h-11 rounded-lg border border-border bg-background px-2 text-xs text-muted-foreground outline-none focus:border-cyan-300/60">
                                            <option value="">{t("team.addAgent")}</option>
                                            {addable.map((role) => <option key={role.id} value={role.id}>{role.title}</option>)}
                                        </select>
                                    </div>
                                    <ul className="space-y-2">
                                        {team.map((m) => {
                                            const role = getAgentTemplate(m.templateId);
                                            const inGroups = plan.groups.filter((g) => g.roles.includes(m.templateId)).map((g) => g.title);
                                            return (
                                                <li key={m.templateId} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-border bg-muted/20 p-2.5 sm:flex">
                                                    <span className="text-lg" aria-hidden>{role?.emoji ?? "🤖"}</span>
                                                    <Input value={names[m.templateId] ?? m.name} onChange={(e) => renameMember(m.templateId, e.target.value)} aria-label={t("team.nameLabel", { role: role?.title ?? m.templateId })} maxLength={40} className="col-span-3 h-11 w-full min-w-0 text-sm sm:w-32" />
                                                    <div className="col-start-2 row-start-1 min-w-0 flex-1">
                                                        <p className="truncate text-xs text-muted-foreground">{role?.title ?? m.templateId}{m.templateId === "boss" && <span className="ml-1.5 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-xs font-semibold text-violet-700 dark:text-violet-200">{t("team.lead")}</span>}</p>
                                                        <p className="truncate text-xs text-muted-foreground">{inGroups.length ? inGroups.join(" · ") : m.templateId === "boss" ? t("team.leadsEveryTeam") : t("team.noGroup")}</p>
                                                    </div>
                                                    <button type="button" onClick={() => removeRole(m.templateId)} aria-label={t("team.remove", { name: m.name || role?.title || m.templateId })} className="col-start-3 row-start-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground">
                                                        <IconX className="h-4 w-4" />
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>

                                {plan.groups.length > 0 && (
                                    <div>
                                        <h2 className="mb-2 text-sm font-medium text-foreground">{t("team.groupChats")}</h2>
                                        <ul className="flex flex-wrap gap-2">
                                            {plan.groups.map((g) => (
                                                <li key={g.teamId} className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
                                                    <span aria-hidden>{g.icon}</span> {g.title} <span className="text-muted-foreground">· {t("team.groupMembers", { names: g.roles.map((r) => (names[r] ?? DEFAULT_AGENT_NAMES[r] ?? r).trim()).join(", ") })}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                {planProblem && team.length > 0 && <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{planProblem}</p>}
                                {!planProblem && team.length > COMFORTABLE_AGENT_COUNT && (
                                    <p className="text-xs text-amber-800 dark:text-amber-200">{t("team.smallMachine", { count: COMFORTABLE_AGENT_COUNT })}</p>
                                )}
                                {!team.some((m) => m.templateId === "boss") && team.length > 1 && (
                                    <p className="text-xs text-amber-800 dark:text-amber-200">{t("team.noBoss")}</p>
                                )}
                            </section>
                        )}

                        {step === "launch" && (
                            <section className="mx-auto max-w-2xl space-y-6">
                                <header>
                                    <h1 id="setup-title" className="text-2xl font-semibold text-foreground">{online ? t("launch.ready") : t("launch.starting")}</h1>
                                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                                        {launching ? t("launch.creating") : online ? t("launch.readyHint") : t("launch.startingHint")}
                                    </p>
                                </header>
                                {/* The first hire waits on the one-time runtime download; show it when one is running. */}
                                <HermesImageProgress
                                    active={launching}
                                    fallback={launching && <p className="flex items-center gap-2 text-sm text-muted-foreground"><IconLoader2 className="h-4 w-4 animate-spin" />{t("launch.creatingCount", { count: team.length })}</p>}
                                />
                                {created && (
                                    <ul className="space-y-2">
                                        {created.map((r) => {
                                            const role = getAgentTemplate(r.templateId);
                                            const up = isOnline(r.agentId);
                                            return (
                                                <li key={r.name} className="flex items-center gap-3 rounded-2xl border border-border bg-muted/20 p-3">
                                                    <span className="text-xl" aria-hidden>{role?.emoji ?? "🤖"}</span>
                                                    <div className="min-w-0 flex-1">
                                                        <p className="text-sm font-medium text-foreground">{r.name}</p>
                                                        <p className="text-xs text-muted-foreground">{!r.success && !up ? r.message : up ? t("launch.createdOnline", { name: r.name }) : t("launch.createdStarting", { name: r.name })}</p>
                                                    </div>
                                                    {!r.success && !r.agentId ? <span className="rounded-full bg-rose-500/15 px-2.5 py-1 text-xs text-rose-700 dark:text-rose-200">{t("launch.failed")}</span>
                                                        : up ? <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs text-emerald-700 dark:text-emerald-300"><IconCircleCheck className="h-3.5 w-3.5" />{t("launch.online")}</span>
                                                            : (!r.success || offlineTooLong) && r.agentId ? <Button size="sm" variant="outline" onClick={() => void retryRuntime(r.agentId!)} disabled={retrying === r.agentId}>{retrying === r.agentId ? tSetup("restarting") : t("launch.retry")}</Button>
                                                                : <IconLoader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={t("launch.startingLabel")} />}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                                {groupsMade.length > 0 && (
                                    <ul className="space-y-1.5" aria-label={t("launch.groupsCreated")}>
                                        {groupsMade.map((g) => (
                                            <li key={g.title} className="flex items-center gap-2 text-xs text-muted-foreground">
                                                {g.ok ? <IconCircleCheck className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300" /> : <IconAlertTriangle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300" />}
                                                <span aria-hidden>{g.icon}</span>
                                                <span className="text-foreground">{g.title}</span>
                                                <span className="truncate">{g.ok ? t("launch.groupWith", { names: g.members.join(", ") }) : t("launch.groupNotReady")}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {created?.some(result => !result.agentId) && <Button variant="outline" onClick={() => void launch()} disabled={launching}>{tSetup("retryProvisioning")}</Button>}
                                {created && groupsMade.some(group => !group.ok) && <Button variant="outline" onClick={() => void createGroups(plan.groups, created)} disabled={groupBusy || launching || created.some(result => !result.agentId)}>{groupBusy ? t("launch.creatingChats") : t("launch.retryChats")}</Button>}
                                {lead && documentIt && (
                                    <div aria-live="polite" className="rounded-2xl border border-cyan-400/25 bg-cyan-400/[0.05] p-5">
                                        <div className="flex items-start gap-3">
                                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan-400/15">
                                                {doc?.state === "done" ? <IconCircleCheck className="h-5 w-5 text-emerald-700 dark:text-emerald-300" /> : <IconBook2 className="h-5 w-5 text-cyan-800 dark:text-cyan-200" />}
                                            </span>
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium text-foreground">{companyName.trim() ? t("launch.documenting", { name: lead.name, company: companyName.trim() }) : t("launch.documentingYours", { name: lead.name })}</p>
                                                <p className="mt-1 text-xs leading-5 text-muted-foreground">{docLabel}</p>
                                                {doc && (
                                                    <div className="mt-3 flex flex-wrap gap-3 text-xs">
                                                        <Link href={`/messages?agent=${lead.agentId}`} className="text-cyan-700 dark:text-cyan-300 hover:underline" onClick={() => void finish("completed")}>{t("launch.watchInChat")}</Link>
                                                        <Link href={doc.taskUrl} className="text-cyan-700 dark:text-cyan-300 hover:underline" onClick={() => void finish("completed")}>{t("launch.openTask")}</Link>
                                                        <Link href="/resources" className="text-cyan-700 dark:text-cyan-300 hover:underline" onClick={() => void finish("completed")}>{t("launch.knowledgeCount", { count: doc.totalNotes })}</Link>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}
                                {online && (
                                    <p className="text-xs leading-5 text-muted-foreground">{t("launch.privateChatHint")}</p>
                                )}
                            </section>
                        )}
                    </div>

                    {/* Footer actions */}
                    <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-4 sm:px-12">
                        <div>
                            {stepIndex > 0 && (step !== "launch" || (!created && !launching)) && (
                                <Button variant="ghost" onClick={() => { setError(""); setStep(STEPS[stepIndex - 1].id); }}><IconArrowLeft className="h-4 w-4" />{t("back")}</Button>
                            )}
                        </div>
                        <div className="flex items-center gap-3">
                            {/* A company that already has a profile goes straight to the model. */}
                            {step === "welcome" && <Button onClick={() => setStep(profileComplete && !hasAgents ? "model" : "company")}>{t("getStarted")}<IconArrowRight className="h-4 w-4" /></Button>}
                            {step === "company" && (
                                <Button onClick={() => void saveCompany()} disabled={!companyValid || savingProfile}>
                                    {savingProfile && <IconLoader2 className="h-4 w-4 animate-spin" />}{hasAgents ? t("saveAndFinish") : t("continue")}{!savingProfile && !hasAgents && <IconArrowRight className="h-4 w-4" />}
                                </Button>
                            )}
                            {step === "model" && (available === false
                                ? <Button onClick={() => void goToDashboard()}>{t("finishSetup")}</Button>
                                : (
                                    <Button onClick={() => void checkKey()} disabled={!modelReady || keyState.status === "checking" || available === null}>
                                        {keyState.status === "checking" ? <><IconLoader2 className="h-4 w-4 animate-spin" />{t("checkingKey")}</> : <>{keyState.status === "unknown" ? t("continueAnyway") : t("continue")}<IconArrowRight className="h-4 w-4" /></>}
                                    </Button>
                                ))}
                            {step === "team" && <Button onClick={() => void launch()} disabled={!teamValid}>{t("createAgents", { count: team.length })}<IconRocket className="h-4 w-4" /></Button>}
                            {step === "launch" && (
                                <>
                                    <Button variant="ghost" onClick={() => void goToDashboard()} disabled={launching}>{t("goToDashboard")}</Button>
                                    <DisabledReason reason={online ? null : lead ? t("leadOffline", { name: lead.name }) : t("yourLeadOffline")}>
                                        <Button onClick={() => void openDirectChat()} disabled={!online}>
                                            {!online && created?.some((r) => r.success) && <IconLoader2 className="h-4 w-4 animate-spin" />}
                                            <IconMessage className="h-4 w-4" />{lead ? t("openDirectChatWith", { name: lead.name }) : t("openDirectChat")}
                                        </Button>
                                    </DisabledReason>
                                </>
                            )}
                        </div>
                    </footer>
                </main>
            </div>
        </div>
    );
}
