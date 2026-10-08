"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    IconArrowLeft, IconArrowRight, IconBook2, IconBuilding, IconCheck, IconCircleCheck, IconCpu,
    IconExternalLink, IconKey, IconLoader2, IconMessage, IconRocket, IconSparkles, IconUsersGroup, IconAlertTriangle, IconX,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentRoleTemplates, getAgentTemplate } from "@/lib/agent-templates";
import { BUSINESS_TYPES, COMFORTABLE_AGENT_COUNT, DEFAULT_AGENT_NAMES, TEAM_TEMPLATES, planTeam, suggestedTeams, teamPlanProblem, type PlannedGroup } from "@/lib/onboarding-shared";
import { cn } from "@/lib/utils";

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
type Created = { name: string; agentId: string | null; success: boolean; message: string; templateId: string };
type AgentRow = { id: string; name: string; status: string; lastSeenAt: string | null };
type DocProgress = { taskId: string; state: string; agentId: string | null; taskUrl: string; notesTouched: string[]; totalNotes: number };

const PROVIDERS = [
    { id: "openrouter", label: "OpenRouter", hint: "One key for hundreds of models, including free ones.", keyUrl: "https://openrouter.ai/keys", defaultModel: "nvidia/nemotron-3-ultra-550b-a55b:free" },
    { id: "deepseek", label: "DeepSeek", hint: "Low-cost DeepSeek models, billed by DeepSeek.", keyUrl: "https://platform.deepseek.com/api_keys", defaultModel: "" },
] as const;

const STEPS: { id: Step; label: string; icon: typeof IconBuilding }[] = [
    { id: "welcome", label: "Welcome", icon: IconSparkles },
    { id: "company", label: "Your company", icon: IconBuilding },
    { id: "model", label: "AI model", icon: IconCpu },
    { id: "team", label: "Your teams", icon: IconUsersGroup },
    { id: "launch", label: "Launch", icon: IconRocket },
];

const STARTUP_GRACE_MS = 3 * 60 * 1000;

export function SetupWizard({ initialCompanyName, initialBusinessType = "", profileComplete, hasAgents }: { initialCompanyName: string; initialBusinessType?: string; profileComplete: boolean; hasAgents: boolean }) {
    const router = useRouter();
    const [step, setStep] = useState<Step>("welcome");
    const [hidden, setHidden] = useState(false);
    const [error, setError] = useState("");

    // Company
    const [companyName, setCompanyName] = useState(initialCompanyName);
    const [whatYouDo, setWhatYouDo] = useState("");
    const [businessType, setBusinessType] = useState<string>(initialBusinessType);
    const [website, setWebsite] = useState("");
    const [houseRules, setHouseRules] = useState("");
    const [documentIt, setDocumentIt] = useState(true);
    const [savingProfile, setSavingProfile] = useState(false);

    // Model
    const [available, setAvailable] = useState<boolean | null>(null);
    const [remotePaired, setRemotePaired] = useState(false);
    const [unavailableReason, setUnavailableReason] = useState("");
    const [provider, setProvider] = useState<string>(PROVIDERS[0].id);
    const [apiKey, setApiKey] = useState("");
    const [model, setModel] = useState<string>(PROVIDERS[0].defaultModel);
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
    const stepIndex = STEPS.findIndex((s) => s.id === step);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch("/api/agents/easy-setup", { cache: "no-store" });
                const data = await res.json();
                if (cancelled) return;
                setAvailable(Boolean(data.available));
                setRemotePaired(Boolean(data.remotePaired));
                setUnavailableReason(data.reason || "");
            } catch {
                if (!cancelled) { setAvailable(false); setUnavailableReason("Could not check whether this installation can start agents."); }
            }
        })();
        return () => { cancelled = true; };
    }, []);

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
            if (!res.ok) throw new Error(data.error || "Could not save your company.");
            if (hasAgents) {
                await finish("completed");
                setHidden(true);
                router.refresh();
                return;
            }
            setStep("model");
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not save your company.");
        } finally {
            setSavingProfile(false);
        }
    };

    // ── Model ────────────────────────────────────────────────────────────────
    const checkKey = async () => {
        if (keyState.status === "unknown") { setStep("team"); return; } // second click: continue anyway
        setKeyState({ status: "checking", message: "" });
        try {
            const res = await fetch("/api/onboarding/validate-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, apiKey }) });
            const data = await res.json();
            if (data.ok === true) { setKeyState({ status: "ok", message: data.detail || "Key works." }); setStep("team"); }
            else if (data.ok === false) setKeyState({ status: "bad", message: data.error });
            else setKeyState({ status: "unknown", message: data.error || "Couldn't check the key." });
        } catch {
            setKeyState({ status: "unknown", message: "Couldn't check the key from here." });
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
    const planProblem = teamPlanProblem(plan);
    const teamValid = !planProblem;
    const addable = agentRoleTemplates.filter((t) => !team.some((m) => m.templateId === t.id));

    // ── Launch ───────────────────────────────────────────────────────────────
    const launch = async () => {
        setStep("launch");
        setLaunching(true);
        setError("");
        try {
            // The lead goes first: it gets the documentation job.
            const ordered = [...team].sort((a, b) => (a.templateId === "boss" ? -1 : b.templateId === "boss" ? 1 : 0));
            const res = await fetch("/api/agents/easy-setup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    llmProvider: provider,
                    llmApiKey: apiKey,
                    llmModel: model.trim() || undefined,
                    agents: ordered.map((m) => {
                        const t = getAgentTemplate(m.templateId);
                        return {
                            name: m.name.trim(),
                            role: t?.title ?? m.templateId,
                            doctrineJson: t ? { "SOUL.md": t.soul, "AGENTS.md": t.agents, "BOOTSTRAP.md": t.bootstrap, "IDENTITY.md": t.identity } : {},
                        };
                    }),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Could not create your agents.");
            const results: Created[] = (data.results || []).map((r: Omit<Created, "templateId">, i: number) => ({ ...r, templateId: ordered[i]?.templateId ?? "" }));
            setCreated(results);
            setLaunchedAt(Date.now());
            if (results.some((r) => r.success && r.agentId)) setApiKey("");
            await createGroups(plan.groups, results);
            router.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not create your agents.");
        } finally {
            setLaunching(false);
        }
    };

    // One group chat per chosen team, with its agents and the Boss; you are
    // added as its creator. A failed group never blocks the agents.
    const createGroups = async (groups: PlannedGroup[], results: Created[]) => {
        const byRole = new Map(results.filter((r) => r.success && r.agentId).map((r) => [r.templateId, r]));
        const made: { title: string; icon: string; ok: boolean; members: string[] }[] = [];
        for (const g of groups) {
            const members = g.roles.map((role) => byRole.get(role)).filter((r): r is Created => Boolean(r));
            if (!members.some((m) => m.templateId !== "boss")) continue;
            const res = await fetch("/api/groups", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: g.title, description: g.description, icon: g.icon, agentIds: members.map((m) => m.agentId) }),
            }).catch(() => null);
            made.push({ title: g.title, icon: g.icon, ok: Boolean(res?.ok), members: members.map((m) => m.name) });
        }
        setGroupsMade(made);
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
    const lead = created?.find((r) => r.success && r.agentId) ?? null;
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
        await fetch(`/api/agents/${agentId}/recreate-runtime`, { method: "POST" }).catch(() => null);
        setLaunchedAt(Date.now());
        setRetrying(null);
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
        if (!doc) return online ? "Handing over the job…" : `Starts as soon as ${lead.name} is online.`;
        if (doc.state === "done") return `Done: ${doc.notesTouched.length || "its"} note${doc.notesTouched.length === 1 ? "" : "s"} written. Every agent now reads them.`;
        if (doc.state === "inbox") return `Sent. Waiting for ${lead.name} to pick it up…`;
        return doc.notesTouched.length ? `Writing… updated ${doc.notesTouched.slice(0, 4).join(", ")}` : `${lead.name} is reading your profile and website…`;
    }, [doc, lead, online]);

    if (hidden) return null;

    const stepsShown = hasAgents ? STEPS.filter((s) => s.id === "welcome" || s.id === "company") : STEPS;

    return (
        <div role="dialog" aria-modal="true" aria-labelledby="setup-title" className="fixed inset-0 z-[200] flex items-center justify-center bg-zinc-950/80 p-0 backdrop-blur-md sm:p-6">
            <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden border-border bg-zinc-950 shadow-2xl sm:h-[min(760px,100%)] sm:flex-row sm:rounded-3xl sm:border">
                {/* Step rail */}
                <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-white/[0.02] p-6 sm:flex">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Emperor setup</p>
                    <ol className="mt-8 space-y-1">
                        {stepsShown.map((s, i) => {
                            const done = i < stepIndex;
                            const current = s.id === step;
                            const Icon = s.icon;
                            return (
                                <li key={s.id} className={cn("flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm", current ? "bg-cyan-400/10 text-zinc-50" : done ? "text-zinc-300" : "text-zinc-500")}>
                                    <span className={cn("flex h-7 w-7 items-center justify-center rounded-full ring-1", current ? "bg-cyan-400/20 text-cyan-200 ring-cyan-400/40" : done ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" : "ring-white/10")}>
                                        {done ? <IconCheck className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                                    </span>
                                    {s.label}
                                </li>
                            );
                        })}
                    </ol>
                    <button type="button" onClick={() => void setUpLater()} className="mt-auto text-left text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline">
                        Set up later
                    </button>
                </aside>

                <main className="flex min-h-0 flex-1 flex-col">
                    {/* Mobile progress */}
                    <div className="flex items-center justify-between border-b border-border px-5 py-3 sm:hidden">
                        <span className="text-xs text-zinc-400">Step {stepIndex + 1} of {stepsShown.length} · {STEPS[stepIndex].label}</span>
                        <button type="button" onClick={() => void setUpLater()} className="text-xs text-zinc-500 underline">Later</button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-8 sm:px-12 sm:py-12">
                        {error && <p role="alert" className="mb-6 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200"><IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}

                        {step === "welcome" && (
                            <section className="mx-auto flex max-w-xl flex-col items-center pt-6 text-center">
                                <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-cyan-400/25 to-violet-500/20 ring-1 ring-white/10">
                                    <IconSparkles className="h-10 w-10 text-cyan-200" />
                                </div>
                                <h1 id="setup-title" className="mt-8 text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">Let&apos;s set up your AI team</h1>
                                <p className="mt-4 text-base leading-7 text-zinc-400">
                                    {hasAgents || profileComplete
                                        ? hasAgents ? "Tell your agents about the company so they work from the same facts. It takes a minute." : "Your company is on file. Connect an AI model and choose your team; your agents start working in about two minutes."
                                        : "Four short steps: your company, an AI model key, the team you want, and then your agents start working. About three minutes."}
                                </p>
                                <ul className="mt-8 grid w-full gap-3 text-left text-sm sm:grid-cols-3">
                                    {[
                                        { icon: IconBuilding, title: "Your company", body: "So agents know what you do" },
                                        { icon: IconUsersGroup, title: "Your teams", body: "Ready-made teams with their own group chats" },
                                        { icon: IconBook2, title: "Documented", body: "Your lead writes the company handbook" },
                                    ].map(({ icon: Icon, title, body }) => (
                                        <li key={title} className="rounded-2xl border border-border bg-white/[0.03] p-4">
                                            <Icon className="h-5 w-5 text-cyan-300" />
                                            <p className="mt-3 font-medium text-zinc-100">{title}</p>
                                            <p className="mt-1 text-xs leading-5 text-zinc-500">{body}</p>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        )}

                        {step === "company" && (
                            <section className="mx-auto max-w-2xl space-y-6">
                                <header>
                                    <h1 id="setup-title" className="text-2xl font-semibold text-zinc-50">Tell us about your company</h1>
                                    <p className="mt-2 text-sm leading-6 text-zinc-400">Every agent reads this before it works. You can change it any time in Knowledge &amp; Rules.</p>
                                </header>
                                <label className="block space-y-2">
                                    <span className="text-sm font-medium text-zinc-200">Company name</span>
                                    <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Acme Robotics" autoFocus />
                                </label>
                                <label className="block space-y-2">
                                    <span className="text-sm font-medium text-zinc-200">What does it do, and for whom?</span>
                                    <textarea value={whatYouDo} onChange={(e) => setWhatYouDo(e.target.value)} rows={3} placeholder="We build warehouse robots for mid-size logistics companies in Europe."
                                        className="w-full resize-y rounded-xl border border-border bg-white/[0.035] px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20" />
                                </label>
                                <fieldset className="space-y-2">
                                    <legend className="text-sm font-medium text-zinc-200">What kind of company is it?</legend>
                                    <div className="grid gap-2 sm:grid-cols-3">
                                        {BUSINESS_TYPES.map((t) => (
                                            <button key={t.id} type="button" aria-pressed={businessType === t.id} onClick={() => setBusinessType(t.id)}
                                                className={cn("rounded-xl border p-3 text-left transition-colors", businessType === t.id ? "border-cyan-400/50 bg-cyan-400/10" : "border-border bg-white/[0.02] hover:border-zinc-600")}>
                                                <span className="block text-sm font-medium text-zinc-100">{t.label}</span>
                                                <span className="mt-0.5 block text-xs text-zinc-500">{t.hint}</span>
                                            </button>
                                        ))}
                                    </div>
                                </fieldset>
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <label className="block space-y-2">
                                        <span className="text-sm font-medium text-zinc-200">Website <span className="font-normal text-zinc-500">(optional)</span></span>
                                        <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://acme.example" type="url" />
                                    </label>
                                    <label className="block space-y-2">
                                        <span className="text-sm font-medium text-zinc-200">House rules <span className="font-normal text-zinc-500">(optional, one per line)</span></span>
                                        <textarea value={houseRules} onChange={(e) => setHouseRules(e.target.value)} rows={2} placeholder={"Never quote prices without approval\nReply to customers in Spanish"}
                                            className="w-full resize-y rounded-xl border border-border bg-white/[0.035] px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20" />
                                    </label>
                                </div>
                                {!hasAgents && (
                                    <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.05] p-4">
                                        <input type="checkbox" checked={documentIt} onChange={(e) => setDocumentIt(e.target.checked)} className="mt-1 h-4 w-4 accent-cyan-400" />
                                        <span>
                                            <span className="flex items-center gap-2 text-sm font-medium text-zinc-100"><IconBook2 className="h-4 w-4 text-cyan-300" />Have my lead agent document the company</span>
                                            <span className="mt-1 block text-xs leading-5 text-zinc-400">Once it&apos;s online, it turns this profile{website ? " and your website" : ""} into Knowledge &amp; Rules notes (overview, products, customers, brand voice) and asks you what it couldn&apos;t find. You&apos;ll watch it happen.</span>
                                        </span>
                                    </label>
                                )}
                            </section>
                        )}

                        {step === "model" && (
                            <section className="mx-auto max-w-2xl space-y-6">
                                <header>
                                    <h1 id="setup-title" className="text-2xl font-semibold text-zinc-50">Connect an AI model</h1>
                                    <p className="mt-2 text-sm leading-6 text-zinc-400">Your agents think with a language model, so they need an API key. It&apos;s stored encrypted and only your agents use it.</p>
                                </header>
                                {available === false ? (
                                    <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-5 text-sm text-amber-100">
                                        <p className="font-medium">This installation can&apos;t start agents by itself.</p>
                                        <p className="mt-1 text-amber-100/80">{unavailableReason}</p>
                                        <p className="mt-3 text-amber-100/80">Add a Hermes worker (Render), run Hermes on another machine and connect it, or reinstall with Docker so Emperor can start agents for you.</p>
                                        <div className="mt-4 flex flex-wrap gap-3">
                                            <Link href="/docs/v1.1/installation#deploy-on-render" className="inline-flex items-center gap-1 text-cyan-300 underline">Add a Hermes worker <IconExternalLink className="h-3.5 w-3.5" /></Link>
                                            <Link href="/docs/v1.1/hermes-runtime" className="inline-flex items-center gap-1 text-cyan-300 underline">Connect a Hermes agent <IconExternalLink className="h-3.5 w-3.5" /></Link>
                                            <Link href="/docs/v1.1/installation" className="inline-flex items-center gap-1 text-cyan-300 underline">Docker install guide <IconExternalLink className="h-3.5 w-3.5" /></Link>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <div className="grid gap-3 sm:grid-cols-2">
                                            {PROVIDERS.map((p) => (
                                                <button key={p.id} type="button" aria-pressed={provider === p.id}
                                                    onClick={() => { setProvider(p.id); setModel(p.defaultModel); setKeyState({ status: "idle", message: "" }); }}
                                                    className={cn("rounded-2xl border p-4 text-left transition-colors", provider === p.id ? "border-cyan-400/50 bg-cyan-400/10" : "border-border bg-white/[0.02] hover:border-zinc-600")}>
                                                    <span className="flex items-center justify-between text-sm font-medium text-zinc-100">{p.label}{p.id === "openrouter" && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Recommended</span>}</span>
                                                    <span className="mt-1 block text-xs leading-5 text-zinc-500">{p.hint}</span>
                                                </button>
                                            ))}
                                        </div>
                                        <label className="block space-y-2">
                                            <span className="flex items-center justify-between text-sm font-medium text-zinc-200">
                                                <span className="flex items-center gap-2"><IconKey className="h-4 w-4 text-cyan-300" />{providerInfo.label} API key</span>
                                                <a href={providerInfo.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-normal text-cyan-300 hover:underline">Get a key <IconExternalLink className="h-3 w-3" /></a>
                                            </span>
                                            <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setKeyState({ status: "idle", message: "" }); }} placeholder={provider === "openrouter" ? "sk-or-v1-…" : "sk-…"} aria-invalid={keyState.status === "bad"} />
                                            {keyState.status === "ok" && <p className="flex items-center gap-1.5 text-xs text-emerald-300"><IconCircleCheck className="h-3.5 w-3.5" />{keyState.message}</p>}
                                            {keyState.status === "bad" && <p role="alert" className="text-xs text-rose-300">{keyState.message}</p>}
                                            {keyState.status === "unknown" && <p className="text-xs text-amber-200">{keyState.message} Click Continue again to go on.</p>}
                                        </label>
                                        {provider === "openrouter" && (
                                            <p className="rounded-xl border border-border bg-white/[0.02] p-3 text-xs leading-5 text-zinc-400">
                                                Starts on a <strong className="text-zinc-200">free model</strong>, so you can try everything at no cost. Switch to a stronger model per agent later.
                                            </p>
                                        )}
                                        <div>
                                            <button type="button" onClick={() => setShowModel((v) => !v)} className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline">{showModel ? "Hide" : "Choose a specific"} model</button>
                                            {showModel && (
                                                <Input className="mt-2" value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider === "openrouter" ? "e.g. anthropic/claude-sonnet-5-5" : "e.g. deepseek-chat"} aria-label="Model" />
                                            )}
                                        </div>
                                    </>
                                )}
                            </section>
                        )}

                        {step === "team" && (
                            <section className="mx-auto max-w-2xl space-y-6">
                                <header>
                                    <h1 id="setup-title" className="text-2xl font-semibold text-zinc-50">Choose your teams</h1>
                                    <p className="mt-2 text-sm leading-6 text-zinc-400">
                                        {businessType && businessType !== "other" ? "Suggested for your kind of company. " : ""}Pick any mix. Each team gets its specialists and its own group chat; the Boss leads them all.
                                    </p>
                                </header>
                                <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Team templates">
                                    {TEAM_TEMPLATES.map((t) => {
                                        const on = teams.includes(t.id);
                                        return (
                                            <button key={t.id} type="button" aria-pressed={on} onClick={() => toggleTeam(t.id)}
                                                className={cn("flex items-start gap-3 rounded-2xl border p-3 text-left transition-colors", on ? "border-cyan-400/50 bg-cyan-400/10" : "border-border bg-white/[0.02] hover:border-zinc-600")}>
                                                <span className="text-xl leading-none" aria-hidden>{t.icon}</span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="flex items-center justify-between gap-2 text-sm font-medium text-zinc-100">
                                                        {t.label}
                                                        <span className={cn("grid h-4 w-4 shrink-0 place-items-center rounded border", on ? "border-cyan-400 bg-cyan-400 text-zinc-950" : "border-zinc-600")}>{on && <IconCheck className="h-3 w-3" />}</span>
                                                    </span>
                                                    <span className="mt-0.5 block text-xs text-zinc-500">{t.hint}</span>
                                                    <span className="mt-1 block text-[11px] text-zinc-500">{t.roles.map((r) => getAgentTemplate(r)?.title ?? r).join(" · ")}</span>
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>

                                <div>
                                    <div className="mb-2 flex items-center justify-between">
                                        <h2 className="text-sm font-medium text-zinc-200">Your agents <span className="font-normal text-zinc-500">({team.length})</span></h2>
                                        <select aria-label="Add a specialist" value="" onChange={(e) => addRole(e.target.value)}
                                            className="h-8 rounded-lg border border-border bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-cyan-300/60">
                                            <option value="">+ Add an agent</option>
                                            {addable.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                                        </select>
                                    </div>
                                    <ul className="space-y-2">
                                        {team.map((m) => {
                                            const t = getAgentTemplate(m.templateId);
                                            const inGroups = plan.groups.filter((g) => g.roles.includes(m.templateId)).map((g) => g.title);
                                            return (
                                                <li key={m.templateId} className="flex items-center gap-3 rounded-xl border border-border bg-white/[0.02] p-2.5">
                                                    <span className="text-lg" aria-hidden>{t?.emoji ?? "🤖"}</span>
                                                    <Input value={names[m.templateId] ?? m.name} onChange={(e) => renameMember(m.templateId, e.target.value)} aria-label={`${t?.title ?? m.templateId} name`} maxLength={40} className="h-8 w-32 shrink-0 text-sm" />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-xs text-zinc-300">{t?.title ?? m.templateId}{m.templateId === "boss" && <span className="ml-1.5 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200">Lead</span>}</p>
                                                        <p className="truncate text-[11px] text-zinc-500">{inGroups.length ? inGroups.join(" · ") : m.templateId === "boss" ? "Leads every team" : "No group"}</p>
                                                    </div>
                                                    <button type="button" onClick={() => removeRole(m.templateId)} aria-label={`Remove ${m.name || t?.title}`} className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200">
                                                        <IconX className="h-4 w-4" />
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>

                                {plan.groups.length > 0 && (
                                    <div>
                                        <h2 className="mb-2 text-sm font-medium text-zinc-200">Group chats</h2>
                                        <ul className="flex flex-wrap gap-2">
                                            {plan.groups.map((g) => (
                                                <li key={g.teamId} className="rounded-full border border-border px-3 py-1 text-xs text-zinc-300">
                                                    <span aria-hidden>{g.icon}</span> {g.title} <span className="text-zinc-500">· {g.roles.map((r) => (names[r] ?? DEFAULT_AGENT_NAMES[r] ?? r).trim()).join(", ")}, you</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                {planProblem && team.length > 0 && <p role="alert" className="text-xs text-rose-300">{planProblem}</p>}
                                {!planProblem && team.length > COMFORTABLE_AGENT_COUNT && (
                                    <p className="text-xs text-amber-200">Each agent runs its own runtime. On a small machine (a Raspberry Pi, a laptop), start with {COMFORTABLE_AGENT_COUNT} or fewer and add more later.</p>
                                )}
                                {!team.some((m) => m.templateId === "boss") && team.length > 1 && (
                                    <p className="text-xs text-amber-200">Without a Boss, assign work to each specialist yourself.</p>
                                )}
                            </section>
                        )}

                        {step === "launch" && (
                            <section className="mx-auto max-w-2xl space-y-6">
                                <header>
                                    <h1 id="setup-title" className="text-2xl font-semibold text-zinc-50">{online ? "Your team is ready" : "Starting your team"}</h1>
                                    <p className="mt-2 text-sm leading-6 text-zinc-400">
                                        {launching ? "Creating your agents…" : online ? "Talk to your lead in its private chat, or give it a project." : "The first start downloads and connects each agent. This can take a minute or two."}
                                    </p>
                                </header>
                                {launching && <p className="flex items-center gap-2 text-sm text-zinc-300"><IconLoader2 className="h-4 w-4 animate-spin" />Creating {team.length} agent{team.length === 1 ? "" : "s"}…</p>}
                                {created && (
                                    <ul className="space-y-2">
                                        {created.map((r) => {
                                            const t = getAgentTemplate(r.templateId);
                                            const up = isOnline(r.agentId);
                                            return (
                                                <li key={r.name} className="flex items-center gap-3 rounded-2xl border border-border bg-white/[0.02] p-3">
                                                    <span className="text-xl" aria-hidden>{t?.emoji ?? "🤖"}</span>
                                                    <div className="min-w-0 flex-1">
                                                        <p className="text-sm font-medium text-zinc-100">{r.name}</p>
                                                        <p className="text-xs text-zinc-500">{!r.success ? r.message : up ? `${r.name} is created and online` : remotePaired ? "Starting on your Render worker…" : `${r.name} is created and starting up…`}</p>
                                                    </div>
                                                    {!r.success ? <span className="rounded-full bg-rose-500/15 px-2.5 py-1 text-xs text-rose-200">Failed</span>
                                                        : up ? <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs text-emerald-300"><IconCircleCheck className="h-3.5 w-3.5" />Online</span>
                                                            : offlineTooLong && r.agentId ? <Button size="sm" variant="outline" onClick={() => void retryRuntime(r.agentId!)} disabled={retrying === r.agentId}>{retrying === r.agentId ? "Restarting…" : "Retry"}</Button>
                                                                : <IconLoader2 className="h-4 w-4 animate-spin text-zinc-400" aria-label="Starting" />}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                                {groupsMade.length > 0 && (
                                    <ul className="space-y-1.5" aria-label="Group chats created">
                                        {groupsMade.map((g) => (
                                            <li key={g.title} className="flex items-center gap-2 text-xs text-zinc-400">
                                                {g.ok ? <IconCircleCheck className="h-3.5 w-3.5 text-emerald-300" /> : <IconAlertTriangle className="h-3.5 w-3.5 text-amber-300" />}
                                                <span aria-hidden>{g.icon}</span>
                                                <span className="text-zinc-200">{g.title}</span>
                                                <span className="truncate">{g.ok ? `group chat with ${g.members.join(", ")} and you` : "couldn't create this group; make it in Messages"}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {created && !created.some((r) => r.success) && (
                                    <Button variant="outline" onClick={() => setStep("team")}>Retry provisioning</Button>
                                )}
                                {lead && documentIt && (
                                    <div aria-live="polite" className="rounded-2xl border border-cyan-400/25 bg-cyan-400/[0.05] p-5">
                                        <div className="flex items-start gap-3">
                                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan-400/15">
                                                {doc?.state === "done" ? <IconCircleCheck className="h-5 w-5 text-emerald-300" /> : <IconBook2 className="h-5 w-5 text-cyan-200" />}
                                            </span>
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium text-zinc-100">{lead.name} is documenting {companyName.trim() || "your company"} in Knowledge &amp; Rules</p>
                                                <p className="mt-1 text-xs leading-5 text-zinc-400">{docLabel}</p>
                                                {doc && (
                                                    <div className="mt-3 flex flex-wrap gap-3 text-xs">
                                                        <Link href={`/messages?agent=${lead.agentId}`} className="text-cyan-300 hover:underline" onClick={() => void finish("completed")}>Watch in chat</Link>
                                                        <Link href={doc.taskUrl} className="text-cyan-300 hover:underline" onClick={() => void finish("completed")}>Open the task</Link>
                                                        <Link href="/resources" className="text-cyan-300 hover:underline" onClick={() => void finish("completed")}>Knowledge &amp; Rules ({doc.totalNotes})</Link>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}
                                {online && (
                                    <p className="text-xs leading-5 text-zinc-500">Its direct chat is private, so no @mention is needed. For work that should be tracked, create a task and assign it; every morning each agent reviews its open tasks.</p>
                                )}
                            </section>
                        )}
                    </div>

                    {/* Footer actions */}
                    <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-4 sm:px-12">
                        <div>
                            {stepIndex > 0 && (step !== "launch" || (!created && !launching)) && (
                                <Button variant="ghost" onClick={() => { setError(""); setStep(STEPS[stepIndex - 1].id); }}><IconArrowLeft className="h-4 w-4" />Back</Button>
                            )}
                        </div>
                        <div className="flex items-center gap-3">
                            {/* A company that already has a profile goes straight to the model. */}
                            {step === "welcome" && <Button onClick={() => setStep(profileComplete && !hasAgents ? "model" : "company")}>Get started<IconArrowRight className="h-4 w-4" /></Button>}
                            {step === "company" && (
                                <Button onClick={() => void saveCompany()} disabled={!companyValid || savingProfile}>
                                    {savingProfile && <IconLoader2 className="h-4 w-4 animate-spin" />}{hasAgents ? "Save and finish" : "Continue"}{!savingProfile && !hasAgents && <IconArrowRight className="h-4 w-4" />}
                                </Button>
                            )}
                            {step === "model" && (available === false
                                ? <Button onClick={() => void goToDashboard()}>Finish setup</Button>
                                : (
                                    <Button onClick={() => void checkKey()} disabled={!apiKey.trim() || keyState.status === "checking" || available === null}>
                                        {keyState.status === "checking" ? <><IconLoader2 className="h-4 w-4 animate-spin" />Checking key…</> : <>{keyState.status === "unknown" ? "Continue anyway" : "Continue"}<IconArrowRight className="h-4 w-4" /></>}
                                    </Button>
                                ))}
                            {step === "team" && <Button onClick={() => void launch()} disabled={!teamValid}>Create {team.length} agent{team.length === 1 ? "" : "s"}<IconRocket className="h-4 w-4" /></Button>}
                            {step === "launch" && (
                                <>
                                    <Button variant="ghost" onClick={() => void goToDashboard()} disabled={launching}>Go to dashboard</Button>
                                    <Button onClick={() => void openDirectChat()} disabled={!online}>
                                        {!online && created?.some((r) => r.success) && <IconLoader2 className="h-4 w-4 animate-spin" />}
                                        <IconMessage className="h-4 w-4" />Open direct chat{lead ? ` with ${lead.name}` : ""}
                                    </Button>
                                </>
                            )}
                        </div>
                    </footer>
                </main>
            </div>
        </div>
    );
}
