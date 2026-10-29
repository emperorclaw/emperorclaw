"use client";

import { useState, type ReactNode } from "react";
import { IconAlertTriangle, IconLoader2, IconRefresh } from "@tabler/icons-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { JobProgress } from "./job-progress";

export type ProvisioningView = {
    jobId: string;
    status: string;
    error: string | null;
    hostId: string;
    hostName?: string | null;
    hostStatus?: string | null;
    profile: string | null;
    expiresAt?: string | null;
};

const RUNNING = new Set(["queued", "sent", "running"]);
const FAILED = new Set(["failed", "timed_out", "canceled", "lost"]);

/**
 * An agent set up on a runtime host (0.22): its setup's live progress, or
 * "Setup failed — Retry / Remove". Retry queues a new setup (a new token; the
 * old ones are revoked). Remove is the agent's Delete (with "also remove it
 * from the host"), passed in as `removeAction`.
 */
export function HostSetupBanner({ agentId, agentName, agentStatus, hostName, provisioning, canAdmin, onChanged, removeAction }: {
    agentId: string;
    agentName: string;
    agentStatus: string;
    hostName: string;
    provisioning: ProvisioningView;
    canAdmin: boolean;
    onChanged: () => void;
    removeAction?: ReactNode;
}) {
    const t = useTranslations("runtimeHosts.setupBanner");
    const tc = useTranslations("common");
    const [retrying, setRetrying] = useState(false);

    const retry = async () => {
        setRetrying(true);
        try {
            const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/provision`, { method: "POST" });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : t("retryFailed"));
            toast.success(t("retrying", { agent: agentName, host: hostName }));
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t("retryFailed"));
        } finally {
            setRetrying(false);
        }
    };

    const waitingOffline = provisioning.status === "queued" && provisioning.hostStatus && provisioning.hostStatus !== "online";
    const minutesLeft = provisioning.expiresAt ? Math.max(0, Math.ceil((new Date(provisioning.expiresAt).getTime() - Date.now()) / 60_000)) : null;

    if (waitingOffline) {
        return (
            <div className="border-b border-amber-500/15 bg-amber-500/[0.04] px-4 py-3 text-xs text-amber-100">
                <p className="flex items-center gap-2 font-medium">
                    <IconLoader2 className="h-4 w-4 animate-spin text-amber-300" aria-hidden="true" />
                    {minutesLeft != null ? t("waitingHostExpires", { host: hostName, minutes: minutesLeft }) : t("waitingHost", { host: hostName })}
                </p>
                <p className="mt-1 text-amber-200/70">{t("waitingHint", { agent: agentName })}</p>
            </div>
        );
    }

    if (RUNNING.has(provisioning.status)) {
        return (
            <div className="border-b border-cyan-500/15 bg-cyan-500/[0.04] px-4 py-3 text-xs text-zinc-200">
                <p className="flex items-center gap-2 font-medium">
                    <IconLoader2 className="h-4 w-4 animate-spin text-cyan-300" aria-hidden="true" />
                    {provisioning.profile ? t("settingUpProfile", { agent: agentName, host: hostName, profile: provisioning.profile }) : t("settingUp", { agent: agentName, host: hostName })}
                </p>
                {canAdmin
                    ? <JobProgress jobId={provisioning.jobId} onDone={() => onChanged()} className="mt-2" />
                    : <p className="mt-1 text-zinc-400">{t("adminCanFollow")}</p>}
            </div>
        );
    }

    if (FAILED.has(provisioning.status)) {
        return (
            <div role="alert" className="border-b border-rose-500/20 bg-rose-500/[0.05] px-4 py-3 text-xs text-rose-100">
                <p className="flex items-center gap-2 font-medium">
                    <IconAlertTriangle className="h-4 w-4 text-rose-300" aria-hidden="true" />
                    {provisioning.hostStatus === "revoked" ? t("failedRevoked", { host: hostName }) : t("failed", { host: hostName })}
                </p>
                {provisioning.error && <p className="mt-1 break-words text-rose-200/80">{provisioning.error}</p>}
                {canAdmin ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button type="button" size="sm" onClick={() => void retry()} disabled={retrying}>
                            <IconRefresh className="h-3.5 w-3.5" aria-hidden="true" />{retrying ? t("retryingButton") : tc("retry")}
                        </Button>
                        {removeAction}
                        <details className="text-zinc-400">
                            <summary className="cursor-pointer">{t("details")}</summary>
                            <JobProgress jobId={provisioning.jobId} className="mt-2" />
                        </details>
                    </div>
                ) : (
                    <p className="mt-1 text-rose-200/70">{t("askAdmin")}</p>
                )}
            </div>
        );
    }

    if (provisioning.status === "succeeded" && agentStatus === "offline") {
        return (
            <div className="border-b border-amber-500/15 bg-amber-500/[0.04] px-4 py-2 text-[11px] text-amber-200/80">
                {provisioning.profile ? t("notConnectedProfile", { host: hostName, profile: provisioning.profile }) : t("notConnected", { host: hostName })}
            </div>
        );
    }
    return null;
}
