"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { IconCircleCheck, IconLoader2, IconX } from "@tabler/icons-react";
import { EasySetupDialog } from "@/app/(app)/agents/easy-setup-dialog";
import { CreateAgentDialog } from "@/app/(app)/agents/create-agent-dialog";
import { AgentDirectChat } from "@/components/agent-direct-chat";

type Worker = { id: string; name: string; status: string; lastSeenAt: string | null };

export function OnboardingTour({ companyId, hasExistingAgents = false }: { companyId: string; hasExistingAgents?: boolean }) {
  const storageKey = `emperor:onboarding-dismissed:${companyId}`;
  const [dismissed, setDismissed] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);
  const [replyConfirmed, setReplyConfirmed] = useState(false);
  const confirmReply = useCallback((message: { text: string }) => {
    if (message.text.split("\n").some(line => /^ACK working[.!]?$/i.test(line.trim()))) setReplyConfirmed(true);
  }, []);
  const worker = workers.find(w => w.id === selectedId) || workers.find(w => w.status === "online" && w.lastSeenAt) || workers[0];
  const online = worker?.status === "online" && Boolean(worker.lastSeenAt);
  useEffect(() => { setReplyConfirmed(false); }, [worker?.id]);

  useEffect(() => {
    setDismissed(window.localStorage.getItem(storageKey) === "true");
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
  }, [storageKey, hasExistingAgents, selectedId]);

  const finish = async (status: "completed" | "dismissed") => {
    try {
      const response = await fetch("/api/onboarding", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
      if (!response.ok) throw new Error("Could not save setup progress. Please retry.");
      window.localStorage.setItem(storageKey, "true");
      if (status === "completed") setCompleted(true);
      else setDismissed(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save setup progress."); }
  };

  // Another user may register a worker after the dashboard was rendered.
  // Keep this flow only when this user is actively setting up its first worker.
  if (dismissed || completed || ((hasExistingAgents || workers.length > 0) && !selectedId)) return null;
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-5" aria-label="First agent setup">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Create your first Hermes agent</h2>
          <p className="mt-1 text-sm text-zinc-400">Choose a role and provide an LLM API key. Emperor installs and connects the worker for you.</p>
        </div>
        <button type="button" aria-label="Dismiss onboarding" onClick={() => void finish("dismissed")} className="rounded p-2 text-zinc-400 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-cyan-400"><IconX className="h-4 w-4" /></button>
      </div>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <ol className="space-y-4 text-sm">
        <li className="space-y-2">
          <h3 className="font-medium text-zinc-200">1. Create a worker</h3>
          <p className="text-zinc-400">Pick a role and short name, then enter your provider&apos;s API key. Hermes, its plugin, access token, and connection are automatic. The first image download may take a few minutes.</p>
          {available === null ? <p className="flex items-center gap-2 text-zinc-400"><IconLoader2 className="h-4 w-4 animate-spin" />Checking this installation…</p> : available ? (
            <EasySetupDialog localOnly onAgentCreated={setSelectedId} onSwitchToAdvanced={() => setAdvancedOpen(true)} />
          ) : (
            <div className="rounded-lg border border-amber-500/20 p-3 text-amber-200">
              <p>{reason}</p>
              <Link href="/docs/v1.1/installation" className="mt-2 inline-block underline">Open the Docker setup guide</Link>
              <p className="mt-1 text-xs">Hosted services without a Docker socket need a remote Hermes worker; use the remote setup guide.</p>
            </div>
          )}
          <CreateAgentDialog open={advancedOpen} onOpenChange={setAdvancedOpen} hideTrigger onAgentCreated={setSelectedId} />
        </li>
        <li className="space-y-2">
          <h3 className="font-medium text-zinc-200">2. Wait for the worker to connect</h3>
          <p aria-live="polite" className={online ? "text-emerald-300" : "text-zinc-400"}>
            {online ? `${worker.name} is online — its runtime has checked in.` : worker ? `${worker.name} is registered; waiting for its runtime to check in…` : "Create a worker above to begin."}
          </p>
          {worker && !online && <p className="text-xs text-zinc-400">If it stays offline, open <Link className="underline" href={`/agents/${worker.id}`}>agent details</Link> and check the setup results or retry local setup. <Link href="/docs/v1.1/agent-quickstart" className="underline">Troubleshooting</Link></p>}
        </li>
        <li className="space-y-2">
          <h3 className="font-medium text-zinc-200">3. Test a private conversation</h3>
          <p className="text-zinc-400">This is a private chat with your worker, so no @mention is needed. When online, send: “Hello! Reply exactly ACK working.” In team chat, use the @ picker to address your agent.</p>
          {worker && online && <AgentDirectChat key={worker.id} agentId={worker.id} agentName={worker.name} onAgentReply={confirmReply} />}
          <p role="status" className={replyConfirmed ? "text-emerald-300" : "text-zinc-400"}>{replyConfirmed ? "Test reply received. Your worker can answer messages." : "Finish setup unlocks when your worker replies with ACK working. If no reply arrives, check agent details for runtime or provider errors."}</p>
          <button type="button" disabled={!replyConfirmed} onClick={() => void finish("completed")} className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-white hover:bg-cyan-500 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-cyan-400"><IconCircleCheck className="h-4 w-4" />Finish setup</button>
        </li>
      </ol>
      <div className="border-t border-zinc-800 pt-4 text-sm text-zinc-400 space-y-2">
        <p>Next: <Link href="/projects" className="text-cyan-300 underline">create a short project</Link> such as “Acme Launch”, then add one task with a clear result and assign it to your worker.</p>
        <p>In group chat, use the @ picker to address your agent. Direct chat needs no mention. Add Knowledge &amp; Rules only for reusable instructions; enable auto-injection for short rules the agent needs repeatedly.</p>
      </div>
    </section>
  );
}
