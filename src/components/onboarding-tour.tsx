"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clipboard,
  KeyRound,
  Loader2,
  PlugZap,
  Terminal,
  X,
} from "lucide-react";

type OnboardingTourProps = {
  companyId: string;
  initialAgentCount: number;
  initialTokenCount: number;
};

type CreatedToken = {
  id: string;
  name: string;
  secret: string;
};

type AgentsResponse = {
  agents?: Array<{ id: string; name: string }>;
};

function slugifyAgentName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "operator-one";
}

function getShellPrefix(command: string, token: string): string {
  return `$env:EMPEROR_CLAW_API_TOKEN="${token}"\n${command}`;
}

function CommandBlock({ command, onCopy }: { command: string; onCopy: () => void }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/80 overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-800/70 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">
          <Terminal className="h-3.5 w-3.5" />
          Terminal
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-800 px-2 py-1 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          <Clipboard className="h-3.5 w-3.5" />
          Copy
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap p-3 text-xs leading-5 text-zinc-300">
        <code>{command}</code>
      </pre>
    </div>
  );
}

function StepBadge({ done, index }: { done: boolean; index: number }) {
  return (
    <div
      className={
        done
          ? "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-xs font-semibold text-zinc-400"
      }
    >
      {done ? <CheckCircle2 className="h-4 w-4" /> : index}
    </div>
  );
}

export function OnboardingTour({ companyId, initialAgentCount, initialTokenCount }: OnboardingTourProps) {
  const storageKey = `emperor:onboarding-dismissed:${companyId}`;
  const [dismissed, setDismissed] = useState(false);
  const [agentCount, setAgentCount] = useState(initialAgentCount);
  const [tokenCount, setTokenCount] = useState(initialTokenCount);
  const [tokenName, setTokenName] = useState("OpenClaw setup token");
  const [agentName, setAgentName] = useState("Operator One");
  const [createdToken, setCreatedToken] = useState<CreatedToken | null>(null);
  const [isCreatingToken, setIsCreatingToken] = useState(false);
  const [tokenError, setTokenError] = useState("");
  const [copiedLabel, setCopiedLabel] = useState("");

  const agentId = useMemo(() => slugifyAgentName(agentName), [agentName]);
  const activeToken = createdToken?.secret || "paste_token_here";
  const installCommand = "openclaw plugins install clawhub:@malecu/emperor-claw-os-plugin";
  const addAgentCommand = `openclaw emperor add-agent --agent-name "${agentName.trim() || "Operator One"}" --local-brain-agent-id ${agentId} --token "${activeToken}" --profile operator`;
  const doctorCommand = getShellPrefix("openclaw emperor doctor", activeToken);
  const statusCommand = getShellPrefix("openclaw emperor status", activeToken);
  const hasAgent = agentCount > 0;
  const hasToken = tokenCount > 0 || Boolean(createdToken);

  useEffect(() => {
    setDismissed(window.localStorage.getItem(storageKey) === "true");
  }, [storageKey]);

  const persistOnboardingStatus = useCallback(async (status: "completed" | "dismissed") => {
    try {
      await fetch("/api/onboarding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
    } catch {
      // The local browser fallback keeps the UI from reappearing if persistence fails.
    }
  }, []);

  useEffect(() => {
    if (hasAgent) return;

    let cancelled = false;
    const pollAgents = async () => {
      try {
        const response = await fetch("/api/agents", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as AgentsResponse;
        if (!cancelled && Array.isArray(payload.agents)) {
          setAgentCount(payload.agents.length);
        }
      } catch {
        // Polling is best-effort; the dashboard auto-refresh still updates server state.
      }
    };

    const intervalId = window.setInterval(() => {
      void pollAgents();
    }, 5000);
    void pollAgents();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [hasAgent]);

  const dismiss = () => {
    window.localStorage.setItem(storageKey, "true");
    void persistOnboardingStatus("dismissed");
    setDismissed(true);
  };

  useEffect(() => {
    if (!hasAgent) return;
    window.localStorage.setItem(storageKey, "true");
    void persistOnboardingStatus("completed");
  }, [hasAgent, persistOnboardingStatus, storageKey]);

  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedLabel(label);
    window.setTimeout(() => setCopiedLabel(""), 1800);
  };

  const createToken = async () => {
    if (!tokenName.trim() || isCreatingToken) return;
    setIsCreatingToken(true);
    setTokenError("");
    try {
      const response = await fetch("/api/settings/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tokenName.trim(), scope: "mcp_full" }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : "Token creation failed.");
      }
      setCreatedToken({
        id: String(payload.token.id),
        name: String(payload.token.name),
        secret: String(payload.secret),
      });
      setTokenCount((count) => count + 1);
    } catch (error: unknown) {
      setTokenError(error instanceof Error ? error.message : "Token creation failed.");
    } finally {
      setIsCreatingToken(false);
    }
  };

  if (dismissed && !hasAgent) {
    return null;
  }

  return (
    <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/50 shadow-sm overflow-hidden">
      <div className="flex flex-col gap-4 border-b border-zinc-800/70 p-5 md:flex-row md:items-start md:justify-between">
        <div className="flex gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
            <PlugZap className="h-5 w-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-zinc-100">Connect your first OpenClaw agent</h2>
              {hasAgent ? (
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300">
                  Agent detected
                </span>
              ) : (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-200">
                  Waiting for runtime
                </span>
              )}
            </div>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-400">
              Emperor keeps durable state in this workspace. OpenClaw runs the local brain and bridge that executes work, replies to messages, sends heartbeats, and claims tasks.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="inline-flex cursor-pointer items-center gap-2 self-start rounded-md border border-zinc-800 px-3 py-2 text-sm font-medium text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
          aria-label="Dismiss onboarding"
        >
          <X className="h-4 w-4" />
          Dismiss
        </button>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="divide-y divide-zinc-800/70">
          <div className="flex gap-4 p-5">
            <StepBadge index={1} done={hasToken} />
            <div className="min-w-0 flex-1 space-y-4">
              <div>
                <h3 className="font-medium text-zinc-100">Create a setup token</h3>
                <p className="mt-1 text-sm text-zinc-500">
                  This token authenticates the plugin while it registers the first local agent and seeds shared operating doctrine.
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  value={tokenName}
                  onChange={(event) => setTokenName(event.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none transition-colors focus:border-indigo-500/70 focus:ring-2 focus:ring-indigo-500/30"
                  placeholder="Token name"
                />
                <button
                  type="button"
                  onClick={createToken}
                  disabled={!tokenName.trim() || isCreatingToken}
                  className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-default disabled:opacity-50"
                >
                  {isCreatingToken ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  Create Token
                </button>
              </div>
              {createdToken && (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3">
                  <div className="flex items-start gap-2 text-sm text-emerald-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>Copy this token now. Emperor will not show it again after this tour is closed.</p>
                  </div>
                  <div className="mt-3 flex overflow-hidden rounded-md border border-emerald-500/20 bg-zinc-950">
                    <code className="min-w-0 flex-1 overflow-x-auto px-3 py-2 text-xs text-zinc-300">{createdToken.secret}</code>
                    <button
                      type="button"
                      onClick={() => void copy("token", createdToken.secret)}
                      className="inline-flex cursor-pointer items-center border-l border-emerald-500/20 px-3 text-emerald-200 transition-colors hover:bg-emerald-500/10"
                      aria-label="Copy token"
                    >
                      {copiedLabel === "token" ? <CheckCircle2 className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              )}
              {tokenError && (
                <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-300">
                  {tokenError}
                </div>
              )}
            </div>
          </div>

          <div className="flex gap-4 p-5">
            <StepBadge index={2} done={false} />
            <div className="min-w-0 flex-1 space-y-4">
              <div>
                <h3 className="font-medium text-zinc-100">Install the Emperor plugin</h3>
                <p className="mt-1 text-sm text-zinc-500">
                  Run this in the terminal where OpenClaw is installed.
                </p>
              </div>
              <CommandBlock command={installCommand} onCopy={() => void copy("install", installCommand)} />
            </div>
          </div>

          <div className="flex gap-4 p-5">
            <StepBadge index={3} done={hasAgent} />
            <div className="min-w-0 flex-1 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-sm font-medium text-zinc-400">Agent display name</span>
                  <input
                    value={agentName}
                    onChange={(event) => setAgentName(event.target.value)}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none transition-colors focus:border-indigo-500/70 focus:ring-2 focus:ring-indigo-500/30"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-sm font-medium text-zinc-400">Local brain id</span>
                  <input
                    value={agentId}
                    readOnly
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2.5 text-sm text-zinc-500 outline-none"
                  />
                </label>
              </div>
              <CommandBlock command={addAgentCommand} onCopy={() => void copy("add-agent", addAgentCommand)} />
              <div className="grid gap-3 md:grid-cols-2">
                <CommandBlock command={doctorCommand} onCopy={() => void copy("doctor", doctorCommand)} />
                <CommandBlock command={statusCommand} onCopy={() => void copy("status", statusCommand)} />
              </div>
            </div>
          </div>
        </div>

        <aside className="border-t border-zinc-800/70 bg-zinc-950/35 p-5 lg:border-l lg:border-t-0">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300">
                <Bot className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-200">Connection check</p>
                <p className="text-xs text-zinc-500">Polling every 5 seconds</p>
              </div>
            </div>
            <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/70 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-500">Tokens</span>
                <span className={hasToken ? "text-emerald-300" : "text-zinc-400"}>{tokenCount}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-500">Agents</span>
                <span className={hasAgent ? "text-emerald-300" : "text-zinc-400"}>{agentCount}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                  style={{ width: hasAgent ? "100%" : hasToken ? "50%" : "15%" }}
                />
              </div>
            </div>
            <p className="text-xs leading-5 text-zinc-500">
              When the agent appears, Emperor has received the registration from your local bridge. The dashboard will then show live workload, messages, and attention items for that runtime.
            </p>
            {copiedLabel && (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-300">
                Copied {copiedLabel}.
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
