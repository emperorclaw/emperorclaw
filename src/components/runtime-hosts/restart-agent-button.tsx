"use client";

import { useState } from "react";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { JobProgress } from "./job-progress";

type Target = "bridge" | "gateway";
export type HostTopology = "standalone" | "shared" | "unknown";

/** A one-off key per click (crypto.randomUUID needs a secure context; Emperor may be served over plain http on a LAN). */
function requestKey(): string {
    try {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch {
        // Not a secure context.
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Restart an agent's bridge or gateway on its runtime host (owners/admins).
 * The topology shown here is the host's last report and is for the warnings
 * only: the host's own record decides what a restart touches. On a shared
 * gateway (one Hermes for several agents, e.g. a Raspberry Pi) both the
 * bridge and the gateway serve every agent, and a gateway restart waits until
 * they are idle unless the admin explicitly forces it.
 */
export function RestartAgentButton({ hostId, agentId, agentName, topology, sharedAgents = 0, hostOnline, size = "sm", onFinished }: {
    hostId: string;
    agentId: string;
    agentName: string;
    topology: HostTopology;
    /** How many agents the host reported on its shared gateway. */
    sharedAgents?: number;
    hostOnline: boolean;
    size?: "sm" | "xs";
    onFinished?: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [target, setTarget] = useState<Target>("bridge");
    const [force, setForce] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [jobId, setJobId] = useState<string | null>(null);

    const all = sharedAgents > 1 ? `all ${sharedAgents} agents` : "every agent";
    const mayBeShared = topology !== "standalone";

    const reset = () => {
        setTarget("bridge");
        setForce(false);
        setError(null);
        setJobId(null);
    };

    const start = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/runtime-hosts/${encodeURIComponent(hostId)}/jobs`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    command: "restart_agent",
                    agentId,
                    target,
                    ...(target === "gateway" && force ? { force: true } : {}),
                    idempotencyKey: `restart:${requestKey()}`,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Could not send the restart");
            setJobId(data.job.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not send the restart");
        } finally {
            setBusy(false);
        }
    };

    const hints: Record<Target, string> = {
        bridge: topology === "shared"
            ? `Restarts the bridge for ${all} on this host (they share one). Quick; the models keep running.`
            : "Reconnects the agent to Emperor. Quick; the model keeps running.",
        gateway: topology === "shared"
            ? `Restarts Hermes for ${all} on this shared gateway.`
            : "Restarts Hermes for this agent (a few seconds offline).",
    };

    return (
        <>
            <Button type="button" variant="outline" size={size} onClick={() => { reset(); setOpen(true); }} title={`Restart ${agentName}`}>
                <IconRefresh className="h-3.5 w-3.5" aria-hidden="true" />
                Restart
            </Button>
            <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next && jobId) onFinished?.(); }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Restart {agentName}</DialogTitle>
                        <DialogDescription>
                            The host restarts it and reports back here. Chats and memory are kept; a reply in progress may be interrupted.
                        </DialogDescription>
                    </DialogHeader>
                    {!jobId ? (
                        <div className="grid gap-3">
                            <div role="radiogroup" aria-label="What to restart" className="grid gap-2">
                                {(["bridge", "gateway"] as const).map((value) => (
                                    <button key={value} type="button" role="radio" aria-checked={target === value} onClick={() => setTarget(value)}
                                        className={cn("flex min-h-11 flex-col items-start rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                            target === value ? "border-primary/50 bg-primary/10" : "border-border hover:border-primary/30")}>
                                        <span className="text-sm font-medium text-foreground">{value === "bridge" ? "Bridge" : "Gateway"}</span>
                                        <span className="text-xs text-muted-foreground">{hints[value]}</span>
                                    </button>
                                ))}
                            </div>
                            {mayBeShared && (
                                <div role="note" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-foreground">
                                    <p className="flex items-center gap-1.5 font-medium"><IconAlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                                        {topology === "shared" ? "Shared gateway" : "This host has not said how this agent runs"}
                                    </p>
                                    <p className="mt-1 text-muted-foreground">
                                        {topology === "shared"
                                            ? `${agentName} shares its bridge and gateway with the other agents on this host: a restart restarts ${all}, not only ${agentName}.`
                                            : `If ${agentName} shares a gateway with other agents, a restart restarts all of them.`}
                                        {" "}A shared gateway restart waits until none of them is working (up to 4 minutes).
                                    </p>
                                    {target === "gateway" && (
                                        <label className="mt-2 flex min-h-11 items-start gap-2 text-foreground">
                                            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="mt-0.5 h-4 w-4" />
                                            <span>Restart now even if an agent is busy. <span className="text-muted-foreground">Replies in progress on {topology === "shared" ? all : "every agent on a shared gateway"} are cut off.</span></span>
                                        </label>
                                    )}
                                </div>
                            )}
                            {!hostOnline && <p className="text-xs text-muted-foreground">The host is offline: the restart runs when it reconnects (within the hour).</p>}
                            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                        </div>
                    ) : (
                        <JobProgress jobId={jobId} />
                    )}
                    <DialogFooter>
                        {!jobId ? (
                            <>
                                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                                <Button type="button" variant={force ? "destructive" : "default"} onClick={() => void start()} disabled={busy}>
                                    {busy ? "Sending…" : force ? "Restart now" : `Restart ${target}`}
                                </Button>
                            </>
                        ) : (
                            <Button type="button" variant="outline" onClick={() => { setOpen(false); onFinished?.(); }}>Close</Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
