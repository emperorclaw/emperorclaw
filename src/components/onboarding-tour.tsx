"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { IconCircleCheck, IconLoader2, IconX } from "@tabler/icons-react";
import { EasySetupDialog } from "@/app/(app)/agents/easy-setup-dialog";
import { CreateAgentDialog } from "@/app/(app)/agents/create-agent-dialog";

type Worker = { id: string; name: string; status: string; lastSeenAt: string | null };

export function OnboardingTour({ hasExistingAgents = false }: { hasExistingAgents?: boolean }) {
  // Dismissal/completion is owned by the server (users.onboarding_completed_at
  // / onboarding_dismissed_at): the dashboard only renders this tour while the
  // account is unresolved. A localStorage flag used to gate it too, which made
  // onboarding impossible to re-run after a server-side reset.
  const [dismissed, setDismissed] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState("");
  const [createdAtMs, setCreatedAtMs] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [profileComplete, setProfileComplete] = useState<boolean | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [whatYouDo, setWhatYouDo] = useState("");
  const [industry, setIndustry] = useState("");
  const [website, setWebsite] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState("");
  const router = useRouter();
  // While an agent is being created, prefer it; otherwise fall back to the
  // first online worker, then the first worker at all.
  const worker = workers.find(w => w.id === selectedId) || workers.find(w => w.status === "online" && w.lastSeenAt) || workers[0];
  const online = worker?.status === "online" && Boolean(worker.lastSeenAt);
  const justCreated = Boolean(selectedId) && Boolean(worker);
  // The first boot of a Hermes runtime clones a profile and starts the bridge,
  // which can take a minute or two. Only offer a manual retry after that.
  const startupGraceMs = 3 * 60 * 1000;
  const offlineTooLong = justCreated && !online && createdAtMs !== null && Date.now() - createdAtMs > startupGraceMs;

  useEffect(() => {
    if (hasExistingAgents && !selectedId) return;
    let cancelled = false;
    const check = async () => {
      try {
        const [setupResponse, agentsResponse] = await Promise.all([
          fetch("/api/agents/easy-setup", { cache: "no-store" }),
          fetch("/api/agents", { cache: "no-store" }),
        ]);
        if (!setupResponse.ok || !agentsResponse.ok) throw new Error("Could not check setup. Retry or refresh this page.");
        const [setup, roster] = await Promise.all([setupResponse.json(), agentsResponse.json()]);
        if (cancelled) return;
        setAvailable(Boolean(setup.available));
        setReason(setup.reason || "Local setup is unavailable on this installation.");
        setWorkers(roster.agents || []);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Setup check failed.");
      }
    };
    void check();
    const interval = window.setInterval(check, 5000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [hasExistingAgents, selectedId]);

  useEffect(() => {
    let cancelled = false;
    const loadProfile = async () => {
      try {
        const response = await fetch("/api/onboarding/profile", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled) return;
        setProfileComplete(Boolean(data.profileComplete));
        if (typeof data.name === "string") setCompanyName(data.name);
      } catch {
        // Leave the profile step hidden rather than blocking first-run setup.
      }
    };
    void loadProfile();
    return () => { cancelled = true; };
  }, []);

  const saveProfile = async () => {
    if (savingProfile) return;
    setSavingProfile(true);
    setProfileError("");
    try {
      const response = await fetch("/api/onboarding/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName, whatYouDo, industry, website }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save your company profile.");
      setProfileComplete(true);
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : "Could not save your company profile.");
    } finally {
      setSavingProfile(false);
    }
  };

  const finish = async (status: "completed" | "dismissed") => {
    try {
      const response = await fetch("/api/onboarding", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
      if (!response.ok) throw new Error("Could not save setup progress. Please retry.");
      if (status === "completed") setCompleted(true);
      else setDismissed(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save setup progress."); }
  };

  const handleAgentCreated = (id: string) => {
    setSelectedId(id);
    setCreatedAtMs(Date.now());
  };

  // Mark setup done, then jump straight into the private thread with the agent
  // that was just created — the point of hiring it is to talk to it.
  const openDirectChat = async () => {
    const agentId = worker?.id || selectedId;
    await finish("completed");
    if (agentId) router.push(`/messages?agent=${agentId}`);
  };

  // Re-provision the runtime if the agent never came online. Restarts the
  // startup clock so the "starting up" window resets.
  const retryRuntime = async () => {
    const agentId = worker?.id || selectedId;
    if (!agentId || retrying) return;
    setRetrying(true);
    setError("");
    try {
      const response = await fetch(`/api/agents/${agentId}/recreate-runtime`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not restart the runtime.");
      setCreatedAtMs(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not restart the runtime.");
    } finally {
      setRetrying(false);
    }
  };

  // Another user may register a worker after the dashboard was rendered.
  // Keep this flow only when this user is actively setting up its first worker.
  if (dismissed || completed || ((hasExistingAgents || workers.length > 0) && !selectedId)) return null;

  if (profileComplete === false) {
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-5" aria-label="Company profile setup">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Welcome — tell us about your company</h2>
            <p className="mt-1 text-sm text-zinc-400">A minute now gives every agent the context it needs: your name, what you do, and the rules of the house. You can change any of this later in Settings.</p>
          </div>
          <button type="button" aria-label="Dismiss onboarding" onClick={() => void finish("dismissed")} className="rounded p-2 text-zinc-400 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-cyan-400"><IconX className="h-4 w-4" /></button>
        </div>
        {profileError && <p role="alert" className="text-sm text-rose-300">{profileError}</p>}
        <div className="space-y-3 text-sm">
          <label className="block space-y-1.5">
            <span className="text-zinc-300">Company name</span>
            <input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="e.g. Acme Robotics"
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:ring-1 focus:ring-cyan-500"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-zinc-300">What does your company do?</span>
            <textarea
              value={whatYouDo}
              onChange={(e) => setWhatYouDo(e.target.value)}
              rows={3}
              placeholder="One or two sentences on what you sell or do, and who it is for."
              className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:ring-1 focus:ring-cyan-500"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-zinc-300">Industry <span className="text-zinc-500">(optional)</span></span>
              <input
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="e.g. B2B SaaS"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-zinc-300">Website <span className="text-zinc-500">(optional)</span></span>
              <input
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://example.com"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </label>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void saveProfile()}
            disabled={savingProfile || companyName.trim().length < 2}
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-white hover:bg-cyan-500 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-cyan-400"
          >
            {savingProfile && <IconLoader2 className="h-4 w-4 animate-spin" />}
            {savingProfile ? "Saving…" : "Save and continue"}
          </button>
          <button type="button" onClick={() => setProfileComplete(true)} className="text-xs text-zinc-400 underline hover:text-zinc-200">
            Skip for now
          </button>
        </div>
      </section>
    );
  }

  if (justCreated) {
    return (
      <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-5 space-y-4" aria-label="Agent created">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15">
            <IconCircleCheck className="h-5 w-5 text-emerald-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-zinc-100">{worker?.name} is created</h2>
            <p aria-live="polite" className="mt-1 text-sm text-zinc-300">
              {online
                ? "It's online and ready. You can talk to it right now."
                : "It's starting up. The first run downloads and connects the runtime, which can take a minute or two."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void openDirectChat()}
            disabled={!online}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 font-medium text-emerald-950 hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {!online && <IconLoader2 className="h-4 w-4 animate-spin" />}
            {online ? "Open direct chat" : "Waiting for it to come online…"}
          </button>
          <Link href="/agents" className="text-xs text-zinc-400 underline hover:text-zinc-200">Hire another agent</Link>
          <button type="button" onClick={() => void finish("completed")} className="text-xs text-zinc-400 underline hover:text-zinc-200">Finish setup</button>
        </div>
        {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
        {!online && worker && (
          <p className="text-xs text-zinc-400">
            {offlineTooLong
              ? <>Still offline. <button type="button" onClick={() => void retryRuntime()} disabled={retrying} className="underline hover:text-zinc-200 disabled:opacity-50">{retrying ? "Restarting…" : "Retry runtime"}</button> or open <Link className="underline" href={`/agents/${worker.id}`}>agent details</Link>. <Link href="/docs/v1.1/agent-quickstart" className="underline">Troubleshooting</Link></>
              : "We'll enable the chat button as soon as it checks in."}
          </p>
        )}
        <p className="border-t border-emerald-500/20 pt-3 text-xs text-zinc-400">
          Direct chat is private — no @mention needed. In team chat, @mention an agent to get its reply. To give it work that sticks, create a task and assign it to the agent.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-5" aria-label="First agent setup">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Create your first Hermes agent</h2>
          <p className="mt-1 text-sm text-zinc-400">Start with the Boss (Team Lead) to coordinate the team, or hire a specialist directly. Choose a role and provide an LLM API key — Emperor installs and connects the worker for you.</p>
        </div>
        <button type="button" aria-label="Dismiss onboarding" onClick={() => void finish("dismissed")} className="rounded p-2 text-zinc-400 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-cyan-400"><IconX className="h-4 w-4" /></button>
      </div>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <div className="space-y-3 text-sm">
        <div className="space-y-2">
          <h3 className="font-medium text-zinc-200">1. Create a worker</h3>
          <p className="text-zinc-400">Pick a role and short name, then enter your provider&apos;s API key. Hermes, its plugin, access token, and connection are automatic. The first image download may take a few minutes.</p>
          {available === null ? <p className="flex items-center gap-2 text-zinc-400"><IconLoader2 className="h-4 w-4 animate-spin" />Checking this installation…</p> : available ? (
            <EasySetupDialog localOnly onAgentCreated={handleAgentCreated} onSwitchToAdvanced={() => setAdvancedOpen(true)} />
          ) : (
            <div className="rounded-lg border border-amber-500/20 p-3 text-amber-200">
              <p>{reason}</p>
              <Link href="/docs/v1.1/installation" className="mt-2 inline-block underline">Open the Docker setup guide</Link>
              <p className="mt-1 text-xs">Hosted services without a Docker socket need a remote Hermes worker; use the remote setup guide.</p>
            </div>
          )}
          <CreateAgentDialog open={advancedOpen} onOpenChange={setAdvancedOpen} hideTrigger onAgentCreated={handleAgentCreated} />
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-zinc-400">
          <h3 className="font-medium text-zinc-300">2. Talk to it</h3>
          <p className="mt-1 text-xs">The moment it&apos;s created we drop you into its private direct chat — no @mention needed. Direct chat is private; team chat is shared.</p>
        </div>
      </div>
      <div className="border-t border-zinc-800 pt-4 text-sm text-zinc-400 space-y-2">
        <p>Next: <Link href="/projects" className="text-cyan-300 underline">create a short project</Link> such as “Acme Launch”, then add one task with a clear result and assign it to your worker.</p>
        <p>Add Knowledge &amp; Rules only for reusable instructions; enable auto-injection for short rules the agent needs repeatedly.</p>
      </div>
    </section>
  );
}
