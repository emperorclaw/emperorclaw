"use client";

import { useState } from "react";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
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
    const t = useTranslations("runtimeHosts.restart");
    const tc = useTranslations("common");
    const [open, setOpen] = useState(false);
    const [target, setTarget] = useState<Target>("bridge");
    const [force, setForce] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [jobId, setJobId] = useState<string | null>(null);

    const all = sharedAgents > 1 ? t("allAgents", { count: sharedAgents }) : t("everyAgent");
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
            if (!res.ok) throw new Error(data.error || t("sendFailed"));
            setJobId(data.job.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : t("sendFailed"));
        } finally {
            setBusy(false);
        }
    };

    const hints: Record<Target, string> = {
        bridge: topology === "shared"
            ? t("bridgeSharedHint", { all })
            : t("bridgeHint"),
        gateway: topology === "shared"
            ? t("gatewaySharedHint", { all })
            : t("gatewayHint"),
    };

    return (
        <>
            <Button type="button" variant="outline" size={size} onClick={() => { reset(); setOpen(true); }} title={t("title", { agent: agentName })}>
                <IconRefresh className="h-3.5 w-3.5" aria-hidden="true" />
                {t("button")}
            </Button>
            <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next && jobId) onFinished?.(); }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("title", { agent: agentName })}</DialogTitle>
                        <DialogDescription>
                            {t("description")}
                        </DialogDescription>
                    </DialogHeader>
                    {!jobId ? (
                        <div className="grid gap-3">
                            <div role="radiogroup" aria-label={t("whatToRestart")} className="grid gap-2">
                                {(["bridge", "gateway"] as const).map((value) => (
                                    <button key={value} type="button" role="radio" aria-checked={target === value} onClick={() => setTarget(value)}
                                        className={cn("flex min-h-11 flex-col items-start rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                            target === value ? "border-primary/50 bg-primary/10" : "border-border hover:border-primary/30")}>
                                        <span className="text-sm font-medium text-foreground">{value === "bridge" ? t("bridge") : t("gateway")}</span>
                                        <span className="text-xs text-muted-foreground">{hints[value]}</span>
                                    </button>
                                ))}
                            </div>
                            {mayBeShared && (
                                <div role="note" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-foreground">
                                    <p className="flex items-center gap-1.5 font-medium"><IconAlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                                        {topology === "shared" ? t("sharedGateway") : t("unknownTopology")}
                                    </p>
                                    <p className="mt-1 text-muted-foreground">
                                        {topology === "shared"
                                            ? t("sharedWarning", { agent: agentName, all })
                                            : t("unknownWarning", { agent: agentName })}
                                        {" "}{t("waitsForIdle")}
                                    </p>
                                    {target === "gateway" && (
                                        <label className="mt-2 flex min-h-11 items-start gap-2 text-foreground">
                                            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="mt-0.5 h-4 w-4" />
                                            <span>{t("force")} <span className="text-muted-foreground">{t("forceHint", { who: topology === "shared" ? all : t("everyAgentShared") })}</span></span>
                                        </label>
                                    )}
                                </div>
                            )}
                            {!hostOnline && <p className="text-xs text-muted-foreground">{t("hostOffline")}</p>}
                            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                        </div>
                    ) : (
                        <JobProgress jobId={jobId} />
                    )}
                    <DialogFooter>
                        {!jobId ? (
                            <>
                                <Button type="button" variant="outline" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
                                <Button type="button" variant={force ? "destructive" : "default"} onClick={() => void start()} disabled={busy}>
                                    {busy ? t("sending") : force ? t("restartNow") : target === "bridge" ? t("restartBridge") : t("restartGateway")}
                                </Button>
                            </>
                        ) : (
                            <Button type="button" variant="outline" onClick={() => { setOpen(false); onFinished?.(); }}>{tc("close")}</Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
