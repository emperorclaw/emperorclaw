"use client";

import { useCallback, useEffect, useState } from "react";
import { IconAlertTriangle, IconPlus, IconServer2, IconTrash, IconWorld } from "@tabler/icons-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConnectHostDialog } from "@/components/runtime-hosts/connect-host-dialog";
import { useHostStatusLabel } from "@/components/runtime-hosts/host-picker";
import { RestartAgentButton } from "@/components/runtime-hosts/restart-agent-button";
import { DeleteAgentDialog } from "@/app/(app)/agents/delete-agent-dialog";
import { cn } from "@/lib/utils";
import type { SerializedHost } from "@/lib/runtime-hosts/serialize";

type Host = Omit<SerializedHost, "lastSeenAt" | "createdAt" | "revokedAt"> & { lastSeenAt: string | null; createdAt: string; revokedAt: string | null };

const IDLE_POLL_MS = 15_000;
const BUSY_POLL_MS = 3_000;

/** Conflict reasons with a message under runtimeHosts.tab.conflict (anything else shows as is). */
const CONFLICT_KEYS = { unknown_agent: "unknownAgent", other_emperor: "otherEmperor", other_host: "otherHost", duplicate_profile: "duplicateProfile" } as const;
const OFFLINE_REASONS = new Set(["disconnected", "silent"]);
const TOPOLOGIES = new Set(["shared", "standalone", "unknown"]);
const FAILED_JOB_KEYS = { failed: "failed", timed_out: "timedOut", canceled: "canceled", lost: "lost" } as const;

function mib(value: number | null): string {
    if (value == null) return "?";
    return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value} MB`;
}

/** "12s ago", "5m ago", … (rounded), or "never". */
function useAgo() {
    const t = useTranslations("runtimeHosts.tab");
    const tTime = useTranslations("time");
    return (iso: string | null): string => {
        if (!iso) return t("never");
        const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
        if (s < 60) return t("secondsAgo", { count: s });
        if (s < 3600) return tTime("minutesAgo", { count: Math.round(s / 60) });
        if (s < 86400) return tTime("hoursAgo", { count: Math.round(s / 3600) });
        return tTime("daysAgo", { count: Math.round(s / 86400) });
    };
}

function StatusPill({ status }: { status: string }) {
    const label = useHostStatusLabel();
    const tone = status === "online"
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
        : status === "revoked" ? "border-border bg-muted text-muted-foreground" : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    return <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize", tone)}>
        <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", status === "online" ? "bg-emerald-500" : status === "revoked" ? "bg-muted-foreground" : "bg-amber-500")} />
        {label(status)}
    </span>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
    return <div className="min-w-0"><dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt><dd className="mt-0.5 truncate text-sm text-foreground">{children}</dd></div>;
}

function HostCard({ host, onChanged }: { host: Host; onChanged: () => void }) {
    const t = useTranslations("runtimeHosts.tab");
    const tc = useTranslations("common");
    const ago = useAgo();
    const topologyLabel = (value: string) => TOPOLOGIES.has(value) ? t(`topology.${value as "shared"}`) : value;
    const deletedAgent = (name: string | null | undefined) => name ?? t("deletedAgent");
    const [confirmRevoke, setConfirmRevoke] = useState(false);
    const [revoking, setRevoking] = useState(false);
    const online = host.status === "online";
    const revoked = host.status === "revoked";
    const profileOf = (agentId: string) => host.profiles.find((p) => p.agentId === agentId);
    const sharedAgents = host.profiles.filter((p) => p.topology === "shared" && !p.legacy).length;
    const legacy = host.profiles.filter((p) => p.legacy);
    const runningJobs = host.activeJobs.filter((j) => ["queued", "sent", "running"].includes(j.status));
    // Agents deleted in Emperor whose profile is still to be removed here (they wait for the host).
    const pendingRemovals = runningJobs.filter((j) => j.command === "remove_agent");
    const settingUp = runningJobs.filter((j) => j.command === "provision_agent");
    const canProvision = host.commands.includes("provision_agent");
    // Removals that did not succeed stay until an admin retries or dismisses them.
    const failedRemovals = host.activeJobs.filter((j) => j.command === "remove_agent" && ["failed", "timed_out", "canceled", "lost"].includes(j.status));
    const [confirmCancel, setConfirmCancel] = useState<(typeof pendingRemovals)[number] | null>(null);
    const [acting, setActing] = useState<string | null>(null);
    const profileArg = (j: { args: unknown }) => (j.args as { profile?: string } | null)?.profile ?? "?";

    const jobAction = async (jobId: string, action: "retry" | "dismiss" | "cancel", done: string) => {
        setActing(jobId);
        try {
            const res = await fetch(`/api/runtime-host-jobs/${encodeURIComponent(jobId)}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || t("actionFailed"));
            toast.success(done);
            setConfirmCancel(null);
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t("actionFailed"));
        } finally {
            setActing(null);
        }
    };

    const revoke = async () => {
        setRevoking(true);
        try {
            const res = await fetch(`/api/runtime-hosts/${encodeURIComponent(host.id)}`, { method: "DELETE" });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || t("revokeFailed"));
            const left = (data.leftProfiles ?? []) as { agentName: string | null; profile: string | null }[];
            if (left.length > 0) {
                toast.warning(t("revoked", { host: host.name }), {
                    description: t("leftProfiles", { host: host.name, profiles: left.map((l) => t("agentProfile", { agent: l.agentName ?? t("aDeletedAgent"), profile: l.profile ?? "?" })).join(", ") }),
                    duration: 15000,
                });
            } else {
                toast.success(t("revoked", { host: host.name }));
            }
            setConfirmRevoke(false);
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : t("revokeFailed"));
        } finally {
            setRevoking(false);
        }
    };

    return (
        <article className={cn("emperor-panel min-w-0 rounded-2xl p-4 sm:p-5", revoked && "opacity-70")}>
            <div className="flex flex-wrap items-start gap-3">
                <IconServer2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="min-w-0 break-words text-base font-semibold text-foreground">{host.name}</h3>
                        <StatusPill status={host.status} />
                        {host.versions.updateState === "update-available" && !revoked && (
                            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary" title={t("bridgeAvailable", { version: String(host.versions.latestBridge) })}>
                                {t("updateAvailable")}
                            </span>
                        )}
                    </div>
                    {host.duplicateDaemon && (
                        <p role="alert" className="mt-1 flex items-center gap-1.5 text-xs text-destructive">
                            <IconAlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                            {t("duplicateDaemon")}
                        </p>
                    )}
                    {!online && !revoked && host.offlineReason && (
                        <p className="mt-1 text-xs text-muted-foreground">
                            {OFFLINE_REASONS.has(host.offlineReason) ? t(`offlineReason.${host.offlineReason as "silent"}`) : host.offlineReason}
                        </p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        {[host.os, host.arch].filter(Boolean).join(" · ") || t("unknownSystem")}
                        {host.hostname && host.hostname !== host.name ? ` · ${host.hostname}` : ""}
                        {` · ${t("seen", { when: ago(host.lastSeenAt) })}`}
                    </p>
                </div>
                {!revoked && (
                    <Button type="button" variant="outline" size="sm" onClick={() => setConfirmRevoke(true)} title={t("revokeTitle", { host: host.name })}>
                        <IconTrash className="h-3.5 w-3.5" aria-hidden="true" />{t("revoke")}
                    </Button>
                )}
            </div>

            {!revoked && (
                <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Fact label={t("facts.memory")}>{t("memoryValue", { free: mib(host.resources.memAvailMiB), total: mib(host.resources.memTotalMiB) })}</Fact>
                    <Fact label={t("facts.diskFree")}>{mib(host.resources.diskFreeMiB)}</Fact>
                    <Fact label={t("facts.cpusLoad")}>{host.resources.cpus ?? "?"} · {host.resources.load1 ?? "?"}</Fact>
                    <Fact label={t("facts.browser")}>{host.capabilities.browser ? t("yes") : t("no")}</Fact>
                    <Fact label={t("facts.modelProviders")}>{host.llmProviders.length > 0 ? host.llmProviders.join(", ") : t("noneFound")}</Fact>
                    <Fact label={t("facts.bridge")}>{host.versions.bridge ?? "?"}</Fact>
                    <Fact label={t("facts.hermes")}>{host.versions.hermes ?? "?"}</Fact>
                    <Fact label={t("facts.hostDaemon")}>{host.versions.hostd ?? "?"}</Fact>
                </dl>
            )}

            {!revoked && (
                <div className="mt-4">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("agentsOnHost")}</h4>
                    {host.agents.length === 0 ? (
                        <p className="mt-2 text-sm text-muted-foreground">{online ? t("noAgentsYet") : t("noneReported")}</p>
                    ) : (
                        <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                            {host.agents.map((agent) => {
                                const p = profileOf(agent.id);
                                const topology = p?.topology === "shared" || p?.topology === "standalone" ? p.topology : "unknown";
                                return (
                                    <li key={agent.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium text-foreground">{agent.name}</p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {t("agentLine", { profile: agent.runtimeProfile ?? "?", topology: topologyLabel(topology), bridge: p?.bridge ?? "?", gateway: p?.gateway ?? "?" })}
                                                {p?.lastError ? ` · ${p.lastError}` : ""}
                                            </p>
                                        </div>
                                        <RestartAgentButton hostId={host.id} agentId={agent.id} agentName={agent.name} topology={topology}
                                            sharedAgents={sharedAgents} hostOnline={online} size="xs" onFinished={onChanged} />
                                        <DeleteAgentDialog agentId={agent.id} agentName={agent.name} host={{ name: host.name, canRemove: true }} onDeleted={onChanged}
                                            trigger={<Button type="button" variant="outline" size="xs" title={t("deleteTitle", { agent: agent.name })}><IconTrash className="h-3.5 w-3.5" aria-hidden="true" />{t("delete")}</Button>} />
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    {runningJobs.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{t("jobsInProgress", { count: runningJobs.length })}</p>}
                    {settingUp.length > 0 && (
                        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                            {settingUp.map((j) => <li key={j.id}>{(j.args as { profile?: string } | null)?.profile ? t("settingUpProfile", { agent: j.agentName ?? t("anAgent"), profile: String((j.args as { profile?: string }).profile) }) : t("settingUp", { agent: j.agentName ?? t("anAgent") })}</li>)}
                        </ul>
                    )}
                    {pendingRemovals.length > 0 && (
                        <div className="mt-3">
                            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("pendingRemovals")}</h4>
                            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                                {pendingRemovals.map((j) => (
                                    <li key={j.id} className="flex flex-wrap items-center gap-2">
                                        <span>
                                            {t("removalLine", { agent: deletedAgent(j.agentName), profile: profileArg(j) })}{" "}
                                            {!canProvision ? t("removalWaitsUpdate") : j.status === "queued" ? (online ? t("removalStarting") : t("removalWaitsHost")) : t("removalRunning")}
                                        </span>
                                        {j.status === "queued" && (
                                            <Button type="button" variant="outline" size="xs" onClick={() => setConfirmCancel(j)} disabled={acting === j.id}>{tc("cancel")}</Button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {failedRemovals.length > 0 && (
                        <div className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
                            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-destructive">
                                <IconAlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />{t("failedRemovals")}
                            </h4>
                            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                                {failedRemovals.map((j) => (
                                    <li key={j.id} className="flex flex-wrap items-center gap-2">
                                        <span className="min-w-0 flex-1">
                                            {t("removalLine", { agent: deletedAgent(j.agentName), profile: profileArg(j) })} {j.status in FAILED_JOB_KEYS ? t(`jobStatus.${FAILED_JOB_KEYS[j.status as keyof typeof FAILED_JOB_KEYS]}`) : j.status.replace("_", " ")}{j.error ? `: ${j.error}` : ""}
                                        </span>
                                        {j.status !== "canceled" && !revoked && (
                                            <Button type="button" variant="outline" size="xs" disabled={acting === j.id}
                                                onClick={() => void jobAction(j.id, "retry", t("retryingRemoval", { profile: profileArg(j), host: host.name }))}>{t("retryRemoval")}</Button>
                                        )}
                                        <Button type="button" variant="ghost" size="xs" disabled={acting === j.id}
                                            onClick={() => void jobAction(j.id, "dismiss", t("dismissed"))}>{t("dismiss")}</Button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {online && !canProvision && (
                        <p className="mt-3 text-xs text-muted-foreground">
                            {t("oldDaemon")}
                        </p>
                    )}
                </div>
            )}

            {!revoked && (host.conflicts.length > 0 || legacy.length > 0) && (
                <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-foreground">
                    <p className="flex items-center gap-1.5 font-medium"><IconAlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />{t("notManaged")}</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                        {host.conflicts.map((c) => <li key={`${c.profile}:${c.reason}`}>{t("conflictLine", { profile: c.profile, reason: c.reason in CONFLICT_KEYS ? t(`conflict.${CONFLICT_KEYS[c.reason as keyof typeof CONFLICT_KEYS]}`) : c.reason })}</li>)}
                        {legacy.map((p) => <li key={`legacy:${p.profile}`}>{t("legacyProfile", { profile: p.profile })}</li>)}
                    </ul>
                </div>
            )}

            {!revoked && host.runtimeNodes.length > 0 && (
                <details className="mt-3 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">{t("runtimeNodes", { count: host.runtimeNodes.length })}</summary>
                    <ul className="mt-2 space-y-1 text-muted-foreground">
                        {host.runtimeNodes.map((n) => <li key={n.id} className="truncate">{t("runtimeNodeLine", { name: n.name, topology: n.gatewayTopology ? topologyLabel(n.gatewayTopology) : "?", bridge: n.bridgeVersion ?? "?", when: ago(n.lastSeenAt as unknown as string) })}</li>)}
                    </ul>
                </details>
            )}

            <Dialog open={confirmCancel !== null} onOpenChange={(open) => { if (!open) setConfirmCancel(null); }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("cancelRemovalTitle")}</DialogTitle>
                        <DialogDescription>
                            {t("cancelRemovalBody", { agent: confirmCancel?.agentName ?? t("theDeletedAgent"), profile: confirmCancel ? profileArg(confirmCancel) : "?", host: host.name })}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setConfirmCancel(null)}>{t("keepRemoval")}</Button>
                        <Button type="button" variant="destructive" disabled={!confirmCancel || acting === confirmCancel.id}
                            onClick={() => confirmCancel && void jobAction(confirmCancel.id, "cancel", t("profileStays", { host: host.name }))}>{t("cancelRemoval")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("revokeConfirmTitle", { host: host.name })}</DialogTitle>
                        <DialogDescription>
                            {t("revokeConfirmBody")}
                        </DialogDescription>
                    </DialogHeader>
                    {pendingRemovals.length > 0 && (
                        <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-foreground">
                            <p className="font-medium">{t("revokeRemovalsWarning", { host: host.name })}</p>
                            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                                {pendingRemovals.map((j) => <li key={j.id}>{t("agentProfile", { agent: deletedAgent(j.agentName), profile: profileArg(j) })}</li>)}
                            </ul>
                        </div>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setConfirmRevoke(false)}>{tc("cancel")}</Button>
                        <Button type="button" variant="destructive" onClick={() => void revoke()} disabled={revoking}>{revoking ? t("revoking") : t("revokeHost")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </article>
    );
}

/** Settings → Runtime hosts (owners and admins): paired machines, their agents, restarts, connect and revoke. */
export function RuntimeHostsTab() {
    const t = useTranslations("runtimeHosts.tab");
    const tc = useTranslations("common");
    const [hosts, setHosts] = useState<Host[] | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [connectOpen, setConnectOpen] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await fetch("/api/runtime-hosts", { cache: "no-store" });
            if (!res.ok) throw new Error();
            const data = await res.json() as { hosts: Host[] };
            setHosts(data.hosts);
            setLoadError(false);
        } catch {
            setLoadError(true);
        }
    }, []);

    const busy = (hosts ?? []).some((h) => h.activeJobs.some((j) => ["queued", "sent", "running"].includes(j.status)));
    useEffect(() => {
        void load();
        const timer = setInterval(() => {
            if (typeof document === "undefined" || document.visibilityState === "visible") void load();
        }, busy ? BUSY_POLL_MS : IDLE_POLL_MS);
        return () => clearInterval(timer);
    }, [load, busy]);

    const live = (hosts ?? []).filter((h) => h.status !== "revoked");
    const revoked = (hosts ?? []).filter((h) => h.status === "revoked");

    return (
        <section className="grid gap-4">
            <article className="emperor-panel rounded-2xl p-4 sm:p-6">
                <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                        <h2 className="text-base font-semibold text-foreground">{t("title")}</h2>
                        <p className="text-xs text-muted-foreground">{t("intro")}</p>
                    </div>
                    <Button type="button" onClick={() => setConnectOpen(true)} className="min-h-11"><IconPlus className="h-4 w-4" aria-hidden="true" />{t("connectHost")}</Button>
                </div>
                <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <IconWorld className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {t("localModeNote")}
                </p>
            </article>

            {loadError && !hosts && (
                <div className="emperor-panel rounded-2xl p-6" role="alert">
                    <p className="text-sm text-destructive">{t("loadFailed")}</p>
                    <button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-lg border border-border px-4 text-sm">{tc("retry")}</button>
                </div>
            )}
            {!hosts && !loadError && <div className="emperor-panel h-40 animate-pulse rounded-2xl" />}
            {hosts && live.length === 0 && (
                <div className="emperor-panel rounded-2xl p-6 text-center">
                    <p className="text-sm font-medium text-foreground">{t("emptyTitle")}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{t("emptyBody")}</p>
                </div>
            )}
            {live.map((host) => <HostCard key={host.id} host={host} onChanged={() => void load()} />)}
            {revoked.length > 0 && (
                <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">{t("revokedRecently", { count: revoked.length })}</summary>
                    <div className="mt-3 grid gap-3">{revoked.map((host) => <HostCard key={host.id} host={host} onChanged={() => void load()} />)}</div>
                </details>
            )}

            <ConnectHostDialog open={connectOpen} onOpenChange={setConnectOpen} onConnected={() => void load()} />
        </section>
    );
}
