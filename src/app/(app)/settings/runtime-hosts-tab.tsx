"use client";

import { useCallback, useEffect, useState } from "react";
import { IconAlertTriangle, IconPlus, IconServer2, IconTrash, IconWorld } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConnectHostDialog } from "@/components/runtime-hosts/connect-host-dialog";
import { RestartAgentButton } from "@/components/runtime-hosts/restart-agent-button";
import { DeleteAgentDialog } from "@/app/(app)/agents/delete-agent-dialog";
import { cn } from "@/lib/utils";
import type { SerializedHost } from "@/lib/runtime-hosts/serialize";

type Host = Omit<SerializedHost, "lastSeenAt" | "createdAt" | "revokedAt"> & { lastSeenAt: string | null; createdAt: string; revokedAt: string | null };

const IDLE_POLL_MS = 15_000;
const BUSY_POLL_MS = 3_000;

const CONFLICT_LABEL: Record<string, string> = {
    unknown_agent: "names an agent this company does not have",
    other_emperor: "points at another Emperor",
    other_host: "is already on another host",
    duplicate_profile: "names an agent another profile already runs",
};

const OFFLINE_REASON: Record<string, string> = {
    disconnected: "Offline: the daemon disconnected (stopped, restarted or lost its network).",
    silent: "Offline: no heartbeat for over 90 seconds (machine asleep, off or unreachable).",
};

function mib(value: number | null): string {
    if (value == null) return "?";
    return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value} MB`;
}

function ago(iso: string | null): string {
    if (!iso) return "never";
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}

function StatusPill({ status }: { status: string }) {
    const tone = status === "online"
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
        : status === "revoked" ? "border-border bg-muted text-muted-foreground" : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    return <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize", tone)}>
        <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", status === "online" ? "bg-emerald-500" : status === "revoked" ? "bg-muted-foreground" : "bg-amber-500")} />
        {status}
    </span>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
    return <div className="min-w-0"><dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt><dd className="mt-0.5 truncate text-sm text-foreground">{children}</dd></div>;
}

function HostCard({ host, onChanged }: { host: Host; onChanged: () => void }) {
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
            if (!res.ok) throw new Error(data.error || "That did not work");
            toast.success(done);
            setConfirmCancel(null);
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "That did not work");
        } finally {
            setActing(null);
        }
    };

    const revoke = async () => {
        setRevoking(true);
        try {
            const res = await fetch(`/api/runtime-hosts/${encodeURIComponent(host.id)}`, { method: "DELETE" });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Could not revoke the host");
            const left = (data.leftProfiles ?? []) as { agentName: string | null; profile: string | null }[];
            if (left.length > 0) {
                toast.warning(`${host.name} was revoked`, {
                    description: `Left on ${host.name} (remove by hand with emperor-hermes remove): ${left.map((l) => `${l.agentName ?? "a deleted agent"} (profile ${l.profile ?? "?"})`).join(", ")}`,
                    duration: 15000,
                });
            } else {
                toast.success(`${host.name} was revoked`);
            }
            setConfirmRevoke(false);
            onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not revoke the host");
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
                            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary" title={`Bridge ${host.versions.latestBridge} is available`}>
                                Update available
                            </span>
                        )}
                    </div>
                    {host.duplicateDaemon && (
                        <p role="alert" className="mt-1 flex items-center gap-1.5 text-xs text-destructive">
                            <IconAlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                            Another machine is using this host&apos;s token. Revoke the host and connect each machine with its own code.
                        </p>
                    )}
                    {!online && !revoked && host.offlineReason && (
                        <p className="mt-1 text-xs text-muted-foreground">
                            {OFFLINE_REASON[host.offlineReason] ?? host.offlineReason}
                        </p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        {[host.os, host.arch].filter(Boolean).join(" · ") || "Unknown system"}
                        {host.hostname && host.hostname !== host.name ? ` · ${host.hostname}` : ""}
                        {` · seen ${ago(host.lastSeenAt)}`}
                    </p>
                </div>
                {!revoked && (
                    <Button type="button" variant="outline" size="sm" onClick={() => setConfirmRevoke(true)} title={`Revoke ${host.name}`}>
                        <IconTrash className="h-3.5 w-3.5" aria-hidden="true" />Revoke
                    </Button>
                )}
            </div>

            {!revoked && (
                <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Fact label="Memory">{mib(host.resources.memAvailMiB)} free of {mib(host.resources.memTotalMiB)}</Fact>
                    <Fact label="Disk free">{mib(host.resources.diskFreeMiB)}</Fact>
                    <Fact label="CPUs / load">{host.resources.cpus ?? "?"} · {host.resources.load1 ?? "?"}</Fact>
                    <Fact label="Browser">{host.capabilities.browser ? "Yes" : "No"}</Fact>
                    <Fact label="Model providers">{host.llmProviders.length > 0 ? host.llmProviders.join(", ") : "None found"}</Fact>
                    <Fact label="Bridge">{host.versions.bridge ?? "?"}</Fact>
                    <Fact label="Hermes">{host.versions.hermes ?? "?"}</Fact>
                    <Fact label="Host daemon">{host.versions.hostd ?? "?"}</Fact>
                </dl>
            )}

            {!revoked && (
                <div className="mt-4">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agents on this host</h4>
                    {host.agents.length === 0 ? (
                        <p className="mt-2 text-sm text-muted-foreground">{online ? "No agents of this company found on it yet." : "None reported yet."}</p>
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
                                                profile {agent.runtimeProfile ?? "?"} · {topology} · bridge {p?.bridge ?? "?"}, gateway {p?.gateway ?? "?"}
                                                {p?.lastError ? ` · ${p.lastError}` : ""}
                                            </p>
                                        </div>
                                        <RestartAgentButton hostId={host.id} agentId={agent.id} agentName={agent.name} topology={topology}
                                            sharedAgents={sharedAgents} hostOnline={online} size="xs" onFinished={onChanged} />
                                        <DeleteAgentDialog agentId={agent.id} agentName={agent.name} host={{ name: host.name, canRemove: true }} onDeleted={onChanged}
                                            trigger={<Button type="button" variant="outline" size="xs" title={`Delete ${agent.name}`}><IconTrash className="h-3.5 w-3.5" aria-hidden="true" />Delete</Button>} />
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    {runningJobs.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{runningJobs.length} job{runningJobs.length === 1 ? "" : "s"} in progress…</p>}
                    {settingUp.length > 0 && (
                        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                            {settingUp.map((j) => <li key={j.id}>Setting up {j.agentName ?? "an agent"}{(j.args as { profile?: string } | null)?.profile ? ` (profile ${(j.args as { profile?: string }).profile})` : ""}…</li>)}
                        </ul>
                    )}
                    {pendingRemovals.length > 0 && (
                        <div className="mt-3">
                            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pending removals</h4>
                            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                                {pendingRemovals.map((j) => (
                                    <li key={j.id} className="flex flex-wrap items-center gap-2">
                                        <span>
                                            {j.agentName ?? "A deleted agent"} · profile {profileArg(j)} ·{" "}
                                            {!canProvision ? "waits until this host is updated" : j.status === "queued" ? (online ? "starting…" : "waits for the host to come back") : "removing…"}
                                        </span>
                                        {j.status === "queued" && (
                                            <Button type="button" variant="outline" size="xs" onClick={() => setConfirmCancel(j)} disabled={acting === j.id}>Cancel</Button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {failedRemovals.length > 0 && (
                        <div className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
                            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-destructive">
                                <IconAlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />Removals that did not finish
                            </h4>
                            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                                {failedRemovals.map((j) => (
                                    <li key={j.id} className="flex flex-wrap items-center gap-2">
                                        <span className="min-w-0 flex-1">
                                            {j.agentName ?? "A deleted agent"} · profile {profileArg(j)} · {j.status.replace("_", " ")}{j.error ? `: ${j.error}` : ""}
                                        </span>
                                        {j.status !== "canceled" && !revoked && (
                                            <Button type="button" variant="outline" size="xs" disabled={acting === j.id}
                                                onClick={() => void jobAction(j.id, "retry", `Removing profile ${profileArg(j)} from ${host.name} again`)}>Retry removal</Button>
                                        )}
                                        <Button type="button" variant="ghost" size="xs" disabled={acting === j.id}
                                            onClick={() => void jobAction(j.id, "dismiss", "Dismissed")}>Dismiss</Button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {online && !canProvision && (
                        <p className="mt-3 text-xs text-muted-foreground">
                            This host runs the 0.21 host daemon: update it (emperor-hermes update) to hire agents here and remove them from Emperor.
                        </p>
                    )}
                </div>
            )}

            {!revoked && (host.conflicts.length > 0 || legacy.length > 0) && (
                <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-foreground">
                    <p className="flex items-center gap-1.5 font-medium"><IconAlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />Not managed from here</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                        {host.conflicts.map((c) => <li key={`${c.profile}:${c.reason}`}>Profile {c.profile} {CONFLICT_LABEL[c.reason] ?? c.reason}.</li>)}
                        {legacy.map((p) => <li key={`legacy:${p.profile}`}>Profile {p.profile} still runs the 0.3 bridge (migrate it with emperor-hermes).</li>)}
                    </ul>
                </div>
            )}

            {!revoked && host.runtimeNodes.length > 0 && (
                <details className="mt-3 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Bridges registered from this machine ({host.runtimeNodes.length})</summary>
                    <ul className="mt-2 space-y-1 text-muted-foreground">
                        {host.runtimeNodes.map((n) => <li key={n.id} className="truncate">{n.name} · {n.gatewayTopology ?? "?"} · bridge {n.bridgeVersion ?? "?"} · seen {ago(n.lastSeenAt as unknown as string)}</li>)}
                    </ul>
                </details>
            )}

            <Dialog open={confirmCancel !== null} onOpenChange={(open) => { if (!open) setConfirmCancel(null); }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Cancel this removal?</DialogTitle>
                        <DialogDescription>
                            {confirmCancel?.agentName ?? "The deleted agent"}&apos;s profile ({confirmCancel ? profileArg(confirmCancel) : "?"}) then stays on {host.name}, with its files and services. Its token no longer works. Remove it there by hand with emperor-hermes remove.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setConfirmCancel(null)}>Keep the removal</Button>
                        <Button type="button" variant="destructive" disabled={!confirmCancel || acting === confirmCancel.id}
                            onClick={() => confirmCancel && void jobAction(confirmCancel.id, "cancel", `The profile stays on ${host.name}`)}>Cancel the removal</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Revoke {host.name}?</DialogTitle>
                        <DialogDescription>
                            Its host key stops working at once and its daemon disconnects. Agents keep running on the machine with their own tokens, but Emperor can no longer restart them there. To connect it again, create a new code.
                        </DialogDescription>
                    </DialogHeader>
                    {pendingRemovals.length > 0 && (
                        <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-foreground">
                            <p className="font-medium">These removals will never run; the profiles stay on {host.name}:</p>
                            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                                {pendingRemovals.map((j) => <li key={j.id}>{j.agentName ?? "A deleted agent"} (profile {profileArg(j)})</li>)}
                            </ul>
                        </div>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setConfirmRevoke(false)}>Cancel</Button>
                        <Button type="button" variant="destructive" onClick={() => void revoke()} disabled={revoking}>{revoking ? "Revoking…" : "Revoke host"}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </article>
    );
}

/** Settings → Runtime hosts (owners and admins): paired machines, their agents, restarts, connect and revoke. */
export function RuntimeHostsTab() {
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
                        <h2 className="text-base font-semibold text-foreground">Runtime hosts</h2>
                        <p className="text-xs text-muted-foreground">Machines that run your Hermes agents. Connect one to see its agents, versions and resources, and to restart agents from here.</p>
                    </div>
                    <Button type="button" onClick={() => setConnectOpen(true)} className="min-h-11"><IconPlus className="h-4 w-4" aria-hidden="true" />Connect a host</Button>
                </div>
                <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <IconWorld className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Agents in local mode (Docker on this server) are not listed here. API keys never leave the host: only provider names are reported.
                </p>
            </article>

            {loadError && !hosts && (
                <div className="emperor-panel rounded-2xl p-6" role="alert">
                    <p className="text-sm text-destructive">Could not load runtime hosts.</p>
                    <button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-lg border border-border px-4 text-sm">Retry</button>
                </div>
            )}
            {!hosts && !loadError && <div className="emperor-panel h-40 animate-pulse rounded-2xl" />}
            {hosts && live.length === 0 && (
                <div className="emperor-panel rounded-2xl p-6 text-center">
                    <p className="text-sm font-medium text-foreground">No hosts connected yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">Connect the PC or Raspberry Pi where your agents run. It takes one command.</p>
                </div>
            )}
            {live.map((host) => <HostCard key={host.id} host={host} onChanged={() => void load()} />)}
            {revoked.length > 0 && (
                <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Revoked in the last 30 days ({revoked.length})</summary>
                    <div className="mt-3 grid gap-3">{revoked.map((host) => <HostCard key={host.id} host={host} onChanged={() => void load()} />)}</div>
                </details>
            )}

            <ConnectHostDialog open={connectOpen} onOpenChange={setConnectOpen} onConnected={() => void load()} />
        </section>
    );
}
