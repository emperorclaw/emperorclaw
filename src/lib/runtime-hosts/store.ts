// Runtime hosts: the database side (0.21+). Used by the API routes and by the
// host socket server in server.ts, so it must never import next/server.
//
// Route handlers cannot reach the sockets, so every command goes through the
// database: a job row plus pg_notify('host_jobs', {hostId}); the instance that
// holds the host's socket dispatches it. Every state change is a conditional
// UPDATE (lib/runtime-hosts/job-state.ts), so concurrent instances and the
// sweeper never move a job twice.
//
// provision_agent (0.22): the agent's token is minted in the dispatching
// transaction (claimNextJob), only its hash is kept on the job, and the raw
// token goes out in that one command frame. Every token minted for a job is
// named `host-provision:<jobId>`; a job that ends any other way than
// succeeded revokes them all, a succeeded one keeps only the token the host
// reports it wrote (result.tokenSha256).

import { and, asc, desc, eq, gt, inArray, isNull, like, ne, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, companies, companyTokens, runtimeHostJobEvents, runtimeHostJobs, runtimeHostPairings, runtimeHosts, runtimeNodes } from "@/db/schema";
import { recordAudit, recordAudits, humanActor, SYSTEM_ACTOR, type RecordAuditInput } from "@/lib/audit";
import { HOST_PROVISION_TOKEN_PREFIX, hostProvisionTokenName, mintAgentRuntimeToken, revokeAgentRuntimeTokens } from "@/lib/agent-runtime-tokens";
import { planAdoption, type AdoptionAgent } from "./adoption";
import { COMMAND_DEADLINE_SEC, PROVISION_MEMORY_MIB, hostCommandsFrom, isHostCommand, redactJobArgs, validateCommandArgs, type HostCommand } from "./commands";
import {
    HOST_OFFLINE_AFTER_MS, JOB_ACK_TIMEOUT_MS, JOB_DEADLINE_GRACE_MS, JOB_LOST_AFTER_MS, JOB_QUEUE_EXPIRY_MS,
    MAX_JOB_ATTEMPTS, WAIT_FOR_HOST_COMMANDS, jobEventSources, nextJobStatus, type JobEvent, type JobStatus,
} from "./job-state";

/** The pool or an open transaction: token settlement runs in the transaction that moves the job. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/** A time `ms` before the database clock (the sweeper never trusts the app clock). */
const ago = (ms: number) => sql`now() - make_interval(secs => ${Math.round(ms / 1000)})`;
/** Job progress lines are kept this long, finished jobs this long (batched deletes in the sweeper). */
const EVENT_RETENTION_MS = 30 * 86_400_000;
const JOB_RETENTION_MS = 90 * 86_400_000;
const RETENTION_BATCH = 5000;
import {
    PAIRING_CODE_TTL_MS, generateHostToken, generatePairingCode, hashHostToken, hashPairingCode, hostDisplayName, isHostTokenShape,
} from "./pairing";
import { HOST_LOG_TAIL_MAX, HOST_MAX_PROGRESS_EVENTS, redactHostText, type AckFrame, type HelloFrame, type HeartbeatFrame, type InventoryFrame, type ProgressFrame, type ResultFrame } from "./protocol";

export type RuntimeHostRow = typeof runtimeHosts.$inferSelect;
export type RuntimeHostJobRow = typeof runtimeHostJobs.$inferSelect;

export const HOST_JOBS_CHANNEL = "host_jobs";
/** pg_try_advisory_xact_lock key of the sweeper (one instance sweeps at a time). */
const HOST_SWEEP_LOCK = 1937006964;

export type HostNotification =
    | { kind: "job"; hostId: string }
    | { kind: "revoked"; hostId: string }
    | { kind: "replaced"; hostId: string; connectionId: string };

/** Tell every instance about a host (the one holding its socket acts). */
export async function notifyHost(notification: HostNotification): Promise<void> {
    try {
        await db.execute(sql`SELECT pg_notify(${HOST_JOBS_CHANNEL}, ${JSON.stringify(notification)})`);
    } catch (error) {
        console.error("Failed to notify host_jobs:", error);
    }
}

export function parseHostNotification(raw: string | undefined): HostNotification | null {
    if (!raw) return null;
    try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (typeof data.hostId !== "string") return null;
        if (data.kind === "job" || data.kind === "revoked") return { kind: data.kind, hostId: data.hostId };
        if (data.kind === "replaced" && typeof data.connectionId === "string") return { kind: "replaced", hostId: data.hostId, connectionId: data.connectionId };
        return null;
    } catch {
        return null;
    }
}

// ── pairing ─────────────────────────────────────────────────────────────────

export async function createPairing(companyId: string, userId: string): Promise<{ id: string; code: string; expiresAt: Date }> {
    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    const [row] = await db.insert(runtimeHostPairings).values({
        companyId, codeHash: hashPairingCode(code)!, createdByUserId: userId, expiresAt,
    }).returning({ id: runtimeHostPairings.id });
    await recordAudit({
        companyId, actor: humanActor(userId), action: "company.host_pairing_created",
        target: { type: "company", id: companyId },
    });
    return { id: row.id, code, expiresAt };
}

export type PairInput = {
    code: string;
    hostFingerprint: string;
    hostname: string;
    os?: string | null;
    arch?: string | null;
};

/**
 * Consume a pairing code and create the host. The code is consumed atomically
 * (used once, never after expiry). Re-pairing the same machine (fingerprint)
 * in the same company revokes the previous host row. Returns the raw host
 * token once; only its hash is stored.
 */
export async function consumePairing(input: PairInput): Promise<{ ok: true; host: RuntimeHostRow; token: string } | { ok: false; error: string }> {
    const codeHash = hashPairingCode(input.code);
    if (!codeHash) return { ok: false, error: "Invalid or expired pairing code" };
    const token = generateHostToken();
    let canceled: RuntimeHostJobRow[] = [];
    const result = await db.transaction(async (tx) => {
        const [pairing] = await tx.update(runtimeHostPairings).set({ usedAt: sql`now()` }).where(and(
            eq(runtimeHostPairings.codeHash, codeHash),
            isNull(runtimeHostPairings.usedAt),
            gt(runtimeHostPairings.expiresAt, sql`now()`),
        )).returning();
        if (!pairing) return null;
        const previous = await tx.update(runtimeHosts).set({ revokedAt: sql`now()`, status: "revoked" }).where(and(
            eq(runtimeHosts.companyId, pairing.companyId),
            eq(runtimeHosts.hostFingerprint, input.hostFingerprint),
            isNull(runtimeHosts.revokedAt),
        )).returning({ id: runtimeHosts.id });
        const previousIds = previous.map((p) => p.id);
        if (previousIds.length > 0) {
            await tx.update(agents).set({ runtimeHostId: null }).where(inArray(agents.runtimeHostId, previousIds));
            canceled = await tx.update(runtimeHostJobs).set({ status: "canceled", error: "host re-paired", finishedAt: sql`now()`, updatedAt: sql`now()` })
                .where(and(inArray(runtimeHostJobs.hostId, previousIds), inArray(runtimeHostJobs.status, ["queued", "sent", "running"]))).returning();
            for (const job of canceled) await settleJobTokens(job, null, tx);
        }
        const [host] = await tx.insert(runtimeHosts).values({
            companyId: pairing.companyId,
            name: hostDisplayName(input.hostname),
            hostname: input.hostname.slice(0, 255),
            hostFingerprint: input.hostFingerprint,
            os: input.os?.slice(0, 80) ?? null,
            arch: input.arch?.slice(0, 40) ?? null,
            tokenHash: hashHostToken(token),
            status: "offline",
            createdByUserId: pairing.createdByUserId,
        }).returning();
        await tx.update(runtimeHostPairings).set({ hostId: host.id }).where(eq(runtimeHostPairings.id, pairing.id));
        return { host, previousIds, pairing };
    });
    if (!result) return { ok: false, error: "Invalid or expired pairing code" };
    await auditAbandonedRemovals(canceled, "re-paired");
    for (const hostId of result.previousIds) await notifyHost({ kind: "revoked", hostId });
    await recordAudits([
        {
            companyId: result.host.companyId, actor: humanActor(result.pairing.createdByUserId), action: "runtime_host.paired",
            target: { type: "runtime_host", id: result.host.id },
            after: { name: result.host.name, os: result.host.os, arch: result.host.arch }, meta: { via: "pairing_code" },
        },
        ...result.previousIds.map((id): RecordAuditInput => ({
            companyId: result.host.companyId, actor: SYSTEM_ACTOR, action: "runtime_host.revoked",
            target: { type: "runtime_host", id }, meta: { via: "re_paired" },
        })),
    ]);
    return { ok: true, host: result.host, token };
}

// ── hosts ───────────────────────────────────────────────────────────────────

/** The host a token belongs to: live (not revoked) and in a live (not deleted) company. */
export async function authenticateHostToken(token: string | null): Promise<RuntimeHostRow | null> {
    if (!isHostTokenShape(token)) return null;
    const [row] = await db.select({ host: runtimeHosts }).from(runtimeHosts)
        .innerJoin(companies, eq(companies.id, runtimeHosts.companyId))
        .where(and(
            eq(runtimeHosts.tokenHash, hashHostToken(token)),
            isNull(runtimeHosts.revokedAt),
            isNull(companies.deletedAt),
        )).limit(1);
    return row?.host ?? null;
}

/** Of these hosts, the ones that are no longer live (revoked, or their company deleted). */
export async function deadHostIds(hostIds: readonly string[]): Promise<Set<string>> {
    if (hostIds.length === 0) return new Set();
    const live = await db.select({ id: runtimeHosts.id }).from(runtimeHosts)
        .innerJoin(companies, eq(companies.id, runtimeHosts.companyId))
        .where(and(inArray(runtimeHosts.id, [...hostIds]), isNull(runtimeHosts.revokedAt), isNull(companies.deletedAt)));
    const alive = new Set(live.map((h) => h.id));
    return new Set(hostIds.filter((id) => !alive.has(id)));
}

/** Connections of this host keep replacing each other: two daemons share its token. */
export async function markDuplicateDaemon(hostId: string): Promise<void> {
    const [host] = await db.update(runtimeHosts).set({ duplicateDaemonAt: sql`now()` })
        .where(and(eq(runtimeHosts.id, hostId), isNull(runtimeHosts.revokedAt))).returning();
    if (host) {
        await recordAudit({
            companyId: host.companyId, actor: SYSTEM_ACTOR, action: "runtime_host.duplicate_daemon",
            target: { type: "runtime_host", id: host.id }, after: { name: host.name },
        });
    }
}

export async function getHost(companyId: string, hostId: string): Promise<RuntimeHostRow | null> {
    if (!UUID_RE.test(hostId)) return null;
    const [host] = await db.select().from(runtimeHosts).where(and(eq(runtimeHosts.id, hostId), eq(runtimeHosts.companyId, companyId))).limit(1);
    return host ?? null;
}

export async function renameHost(companyId: string, hostId: string, name: string, userId: string): Promise<RuntimeHostRow | null> {
    const before = await getHost(companyId, hostId);
    if (!before || before.revokedAt) return null;
    const [host] = await db.update(runtimeHosts).set({ name }).where(and(eq(runtimeHosts.id, hostId), eq(runtimeHosts.companyId, companyId))).returning();
    await recordAudit({
        companyId, actor: humanActor(userId), action: "runtime_host.renamed",
        target: { type: "runtime_host", id: hostId }, before: { name: before.name }, after: { name },
    });
    return host ?? null;
}

/** Revoke a host: its token stops working, its socket closes (4401), its agents are released. */
export async function revokeHost(companyId: string, hostId: string, userId: string): Promise<(RuntimeHostRow & { leftProfiles: LeftProfile[] }) | null> {
    let canceled: RuntimeHostJobRow[] = [];
    const host = await db.transaction(async (tx) => {
        const [row] = await tx.update(runtimeHosts).set({ revokedAt: sql`now()`, status: "revoked" }).where(and(
            eq(runtimeHosts.id, hostId), eq(runtimeHosts.companyId, companyId), isNull(runtimeHosts.revokedAt),
        )).returning();
        if (!row) return null;
        await tx.update(agents).set({ runtimeHostId: null }).where(eq(agents.runtimeHostId, hostId));
        // Pending removals go too: with the host revoked nobody can run them (the UI says so).
        canceled = await tx.update(runtimeHostJobs).set({ status: "canceled", error: "host revoked", finishedAt: sql`now()`, updatedAt: sql`now()` })
            .where(and(eq(runtimeHostJobs.hostId, hostId), inArray(runtimeHostJobs.status, ["queued", "sent", "running"]))).returning();
        for (const job of canceled) await settleJobTokens(job, null, tx);
        return row;
    });
    if (!host) return null;
    const leftProfiles = await auditAbandonedRemovals(canceled, "revoked");
    await notifyHost({ kind: "revoked", hostId });
    await recordAudit({
        companyId, actor: humanActor(userId), action: "runtime_host.revoked",
        target: { type: "runtime_host", id: hostId }, after: { name: host.name, status: "revoked" },
    });
    return { ...host, leftProfiles };
}

export type LeftProfile = { agentId: string | null; agentName: string | null; profile: string | null };

/**
 * Removals that will never run (the host was revoked or re-paired): those agents' profiles stay
 * on the machine. Audited per agent so someone can clean them up by hand.
 */
async function auditAbandonedRemovals(jobs: RuntimeHostJobRow[], why: "revoked" | "re-paired"): Promise<LeftProfile[]> {
    const removals = jobs.filter((j) => j.command === "remove_agent");
    if (removals.length === 0) return [];
    const ids = removals.map((j) => j.agentId).filter((id): id is string => Boolean(id));
    const named = ids.length > 0 ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ids)) : [];
    const names = new Map(named.map((a) => [a.id, a.name]));
    const left = removals.map((j) => ({
        agentId: j.agentId, agentName: j.agentId ? names.get(j.agentId) ?? null : null, profile: ((j.argsJson ?? {}) as { profile?: string }).profile ?? null,
    }));
    await recordAudits(removals.map((j, i): RecordAuditInput => ({
        companyId: j.companyId, actor: SYSTEM_ACTOR, action: "runtime_host.removal_abandoned",
        target: { type: "runtime_host", id: j.hostId },
        after: { jobId: j.id, agentId: j.agentId, agentName: left[i].agentName, profile: left[i].profile }, meta: { via: why },
    })));
    return left;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HostListEntry = {
    host: RuntimeHostRow;
    agents: { id: string; name: string; status: string; runtimeProfile: string | null }[];
    /** Names of the agents its jobs are about (deleted ones too: a pending removal names a deleted agent). */
    jobAgentNames: Record<string, string>;
    runtimeNodes: { id: string; name: string; agentId: string | null; bridgeVersion: string | null; gatewayTopology: string | null; status: string; lastSeenAt: Date }[];
    activeJobs: RuntimeHostJobRow[];
};

/** The company's hosts (revoked ones last, only from the last 30 days), with their agents and bridges. */
export async function listHosts(companyId: string): Promise<HostListEntry[]> {
    const hosts = await db.select().from(runtimeHosts).where(and(
        eq(runtimeHosts.companyId, companyId),
        sql`(${runtimeHosts.revokedAt} IS NULL OR ${runtimeHosts.revokedAt} > now() - interval '30 days')`,
    )).orderBy(sql`${runtimeHosts.revokedAt} IS NOT NULL`, asc(runtimeHosts.name), asc(runtimeHosts.createdAt));
    if (hosts.length === 0) return [];
    const hostIds = hosts.map((h) => h.id);
    const live = hosts.filter((h) => !h.revokedAt);
    const [hostAgents, nodes, jobs] = await Promise.all([
        db.select({ id: agents.id, name: agents.name, status: agents.status, runtimeProfile: agents.runtimeProfile, runtimeHostId: agents.runtimeHostId })
            .from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.runtimeHostId, hostIds), isNull(agents.deletedAt)))
            .orderBy(asc(agents.name)),
        live.length > 0
            ? db.select().from(runtimeNodes).where(and(
                eq(runtimeNodes.companyId, companyId),
                inArray(runtimeNodes.hostFingerprint, live.map((h) => h.hostFingerprint)),
                isNull(runtimeNodes.deletedAt),
                sql`${runtimeNodes.lastSeenAt} > now() - interval '7 days'`,
            )).orderBy(asc(runtimeNodes.name))
            : Promise.resolve([] as (typeof runtimeNodes.$inferSelect)[]),
        db.select().from(runtimeHostJobs).where(and(
            inArray(runtimeHostJobs.hostId, hostIds),
            sql`(${runtimeHostJobs.status} IN ('queued', 'sent', 'running') OR ${runtimeHostJobs.finishedAt} > now() - interval '10 minutes'
                OR (${runtimeHostJobs.command} = 'remove_agent' AND ${runtimeHostJobs.status} IN ('failed', 'timed_out', 'canceled', 'lost')
                    AND coalesce(${runtimeHostJobs.resultJson}->>'dismissedAt', '') = ''))`,
            sql`coalesce(${runtimeHostJobs.resultJson}->>'dismissedAt', '') = ''`,
        )).orderBy(desc(runtimeHostJobs.createdAt)).limit(200),
    ]);
    const jobAgentIds = [...new Set(jobs.map((j) => j.agentId).filter((id): id is string => Boolean(id)))];
    const named = jobAgentIds.length > 0
        ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, jobAgentIds)))
        : [];
    const jobAgentNames = Object.fromEntries(named.map((a) => [a.id, a.name]));
    return hosts.map((host) => ({
        host,
        jobAgentNames,
        agents: hostAgents.filter((a) => a.runtimeHostId === host.id).map((a) => ({ id: a.id, name: a.name, status: a.status, runtimeProfile: a.runtimeProfile })),
        runtimeNodes: host.revokedAt ? [] : nodes.filter((n) => n.hostFingerprint === host.hostFingerprint).map((n) => ({
            id: n.id, name: n.name, agentId: n.agentId, bridgeVersion: n.bridgeVersion, gatewayTopology: n.gatewayTopology, status: n.status, lastSeenAt: n.lastSeenAt,
        })),
        activeJobs: jobs.filter((j) => j.hostId === host.id),
    }));
}

// ── socket lifecycle ────────────────────────────────────────────────────────

export type HelloOutcome = { ok: true; host: RuntimeHostRow } | { ok: false; reason: "revoked" | "fingerprint_mismatch" };

/** A host said hello on a fresh socket: record versions and mark it online. */
export async function recordHello(hostId: string, hello: HelloFrame, connectedAt: Date): Promise<HelloOutcome> {
    const [current] = await db.select().from(runtimeHosts).where(eq(runtimeHosts.id, hostId)).limit(1);
    if (!current || current.revokedAt) return { ok: false, reason: "revoked" };
    // Defence in depth only: the fingerprint (sha256 of /etc/machine-id) is
    // not a secret and cannot stop a thief who copies it too. It catches a
    // token copied to another machine by mistake (closed with 4403, which the
    // daemon retries slowly; never a permanent stop).
    if (current.hostFingerprint !== hello.hostFingerprint) return { ok: false, reason: "fingerprint_mismatch" };
    const [host] = await db.update(runtimeHosts).set({
        status: "online",
        hostname: hello.hostname.slice(0, 255),
        os: hello.os ?? current.os,
        arch: hello.arch ?? current.arch,
        protocol: hello.protocol,
        hostdVersion: hello.hostdVersion,
        installerVersion: hello.installerVersion ?? null,
        bridgeVersion: hello.bridgeVersion ?? null,
        hermesVersion: hello.hermesVersion ?? null,
        lastSeenAt: sql`now()`,
        connectedAt,
        offlineReason: null,
        // What this daemon runs (absent on 0.21: null, read as restart + refresh only).
        inventoryJson: sql`jsonb_set(coalesce(${runtimeHosts.inventoryJson}, '{}'::jsonb), '{commands}', ${JSON.stringify(hello.commands ?? null)}::jsonb, true)`,
    }).where(and(eq(runtimeHosts.id, hostId), isNull(runtimeHosts.revokedAt))).returning();
    if (!host) return { ok: false, reason: "revoked" };
    if (current.status !== "online") {
        await recordAudit({
            companyId: host.companyId, actor: SYSTEM_ACTOR, action: "runtime_host.connected",
            target: { type: "runtime_host", id: host.id }, after: { name: host.name, status: "online", hostdVersion: hello.hostdVersion },
        });
    }
    return { ok: true, host };
}

/** false when the host is no longer live (revoked meanwhile): the caller closes the socket. */
export async function recordHeartbeat(hostId: string, frame: HeartbeatFrame): Promise<boolean> {
    const updated = await db.update(runtimeHosts).set({
        lastSeenAt: sql`now()`,
        status: "online",
        inventoryJson: sql`jsonb_set(${runtimeHosts.inventoryJson}, '{heartbeat}', ${JSON.stringify({ memAvailMiB: frame.memAvailMiB ?? null, load1: frame.load1 ?? null, at: new Date().toISOString() })}::jsonb, true)`,
    }).where(and(eq(runtimeHosts.id, hostId), isNull(runtimeHosts.revokedAt))).returning({ id: runtimeHosts.id });
    return updated.length > 0;
}

/** The socket that connected at `connectedAt` closed: offline, unless a newer socket took over. */
export async function recordDisconnect(hostId: string, connectedAt: Date): Promise<void> {
    const [host] = await db.update(runtimeHosts).set({ status: "offline", offlineReason: "disconnected" }).where(and(
        eq(runtimeHosts.id, hostId), eq(runtimeHosts.connectedAt, connectedAt), eq(runtimeHosts.status, "online"),
    )).returning();
    if (host) {
        await recordAudit({
            companyId: host.companyId, actor: SYSTEM_ACTOR, action: "runtime_host.disconnected",
            target: { type: "runtime_host", id: host.id }, after: { name: host.name, status: "offline" },
        });
    }
}

/**
 * A full inventory: store it (provider names, resources, profiles) and adopt
 * the agents its profiles name (lib/runtime-hosts/adoption.ts).
 */
/** null when the host is no longer live (revoked meanwhile): the caller closes the socket. */
export async function recordInventory(hostId: string, frame: InventoryFrame): Promise<{ adopted: string[]; released: string[]; conflicts: number } | null> {
    const [host] = await db.select().from(runtimeHosts).where(and(eq(runtimeHosts.id, hostId), isNull(runtimeHosts.revokedAt))).limit(1);
    if (!host) return null;
    const profiles = frame.profiles.map((p) => ({
        ...p,
        agentId: p.agentId ? p.agentId.toLowerCase() : null,
        health: { registered: p.health.registered ?? null, lastError: redactHostText(p.health.lastError, 300) },
    }));
    const named = [...new Set(profiles.map((p) => p.agentId).filter((id): id is string => Boolean(id)))];

    const outcome = await db.transaction(async (tx) => {
        const namedAgents = named.length > 0
            ? await tx.select({ id: agents.id, companyId: agents.companyId, deletedAt: agents.deletedAt, runtimeHostId: agents.runtimeHostId, runtimeProfile: agents.runtimeProfile, hostRevokedAt: runtimeHosts.revokedAt })
                .from(agents).leftJoin(runtimeHosts, eq(runtimeHosts.id, agents.runtimeHostId))
                .where(inArray(agents.id, named)).for("update", { of: agents })
            : [];
        const agentsById = new Map<string, AdoptionAgent>(namedAgents.map((a) => [a.id, {
            id: a.id, companyId: a.companyId, deleted: Boolean(a.deletedAt), runtimeHostId: a.runtimeHostId,
            runtimeProfile: a.runtimeProfile, runtimeHostRevoked: Boolean(a.hostRevokedAt),
        }]));
        // An agent being set up here (its latest provision job is not done) is not released just
        // because its profile does not exist yet.
        const settingUp = new Set(await agentsBeingProvisioned(hostId, tx));
        const currentlyOnHost = (await tx.select({ id: agents.id }).from(agents).where(eq(agents.runtimeHostId, hostId)))
            .filter((a) => !settingUp.has(a.id));
        const plan = planAdoption({ hostId, companyId: host.companyId, profiles, agentsById, currentlyOnHost });
        // A profile whose (deleted) agent has a removal pending is "being removed", not a conflict.
        const removing = new Set(await agentsBeingRemoved(hostId, tx));
        plan.conflicts = plan.conflicts.filter((c) => !(c.reason === "unknown_agent" && removing.has(c.agentId)));
        for (const item of plan.adopt) {
            await tx.update(agents).set({ runtimeHostId: hostId, runtimeProfile: item.profile }).where(and(eq(agents.id, item.agentId), eq(agents.companyId, host.companyId)));
        }
        if (plan.release.length > 0) {
            await tx.update(agents).set({ runtimeHostId: null }).where(and(inArray(agents.id, plan.release), eq(agents.runtimeHostId, hostId)));
        }
        const inventory = {
            receivedAt: new Date().toISOString(),
            resources: frame.resources,
            capabilities: frame.capabilities,
            llmProviders: frame.llmProviders,
            profiles,
            conflicts: plan.conflicts,
            heartbeat: (host.inventoryJson as { heartbeat?: unknown } | null)?.heartbeat ?? null,
            commands: (host.inventoryJson as { commands?: unknown } | null)?.commands ?? null,
        };
        await tx.update(runtimeHosts).set({ inventoryJson: inventory, lastSeenAt: sql`now()` }).where(eq(runtimeHosts.id, hostId));
        return plan;
    });

    const audits: RecordAuditInput[] = [
        ...outcome.adopt.map((a): RecordAuditInput => ({
            companyId: host.companyId, actor: SYSTEM_ACTOR, action: "agent.runtime_host_changed",
            target: { type: "agent", id: a.agentId }, after: { runtimeHostId: hostId, runtimeProfile: a.profile }, meta: { label: host.name },
        })),
        ...outcome.release.map((agentId): RecordAuditInput => ({
            companyId: host.companyId, actor: SYSTEM_ACTOR, action: "agent.runtime_host_changed",
            target: { type: "agent", id: agentId }, after: { runtimeHostId: null }, meta: { label: host.name },
        })),
    ];
    if (audits.length > 0) await recordAudits(audits);
    return { adopted: outcome.adopt.map((a) => a.agentId), released: outcome.release, conflicts: outcome.conflicts.length };
}

// ── jobs ────────────────────────────────────────────────────────────────────

/** Flat job args as text with sorted keys (jsonb does not keep key order). */
function canonicalArgs(args: unknown): string {
    const entries = args && typeof args === "object" ? Object.entries(args as Record<string, unknown>) : [];
    return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
}

export type QueueJobInput = {
    companyId: string;
    hostId: string;
    agentId: string | null;
    command: HostCommand;
    args: Record<string, unknown>;
    idempotencyKey?: string | null;
    userId: string;
};

/**
 * Queue a job (idempotent by key) and nudge the instance holding the host's
 * socket. A key reused for another host, command or agent is a conflict.
 */
export async function queueJob(input: QueueJobInput): Promise<{ conflict: false; job: RuntimeHostJobRow; created: boolean } | { conflict: true }> {
    const values = {
        companyId: input.companyId,
        hostId: input.hostId,
        agentId: input.agentId,
        command: input.command,
        argsJson: redactJobArgs(input.args),
        status: "queued" as const,
        idempotencyKey: input.idempotencyKey ?? null,
        requestedByUserId: input.userId,
    };
    const inserted = await db.insert(runtimeHostJobs).values(values).onConflictDoNothing().returning();
    let job = inserted[0];
    const created = Boolean(job);
    if (!job && input.idempotencyKey) {
        [job] = await db.select().from(runtimeHostJobs).where(and(
            eq(runtimeHostJobs.companyId, input.companyId), eq(runtimeHostJobs.idempotencyKey, input.idempotencyKey),
        )).limit(1);
    }
    if (!job) throw new Error("job insert failed");
    if (!created && (job.hostId !== input.hostId || job.command !== input.command || job.agentId !== input.agentId
        || canonicalArgs(job.argsJson) !== canonicalArgs(values.argsJson))) return { conflict: true };
    if (created) {
        await notifyHost({ kind: "job", hostId: input.hostId });
        await recordAudit({
            companyId: input.companyId, actor: humanActor(input.userId), action: "runtime_host.job_queued",
            target: { type: "runtime_host", id: input.hostId },
            after: {
                command: input.command, jobId: job.id, agentId: input.agentId, profile: input.args.profile, target: input.args.target,
                ...(input.command === "provision_agent" ? { gateway: input.args.gateway, llmProvider: input.args.llmProvider, model: input.args.model } : {}),
                ...(input.command === "remove_agent" ? { purge: input.args.purge } : {}),
            },
        });
    }
    return { conflict: false, job, created };
}

export type ClaimedJob = {
    job: RuntimeHostJobRow;
    /**
     * The arguments to send when they differ from args_json: provision_agent
     * with its freshly minted token. Never stored, never logged.
     */
    sendArgs: Record<string, unknown> | null;
};

/**
 * Take the host's next queued job that its daemon can run and mark it sent,
 * unless one is already sent or running (one job at a time). The host row
 * lock serialises concurrent dispatchers. A job of a command the daemon does
 * not know (a removal queued for a 0.21 host) waits in the queue until the
 * host is updated.
 *
 * provision_agent: the agent's token is minted here, in the same
 * transaction, bound to the agent and named after the job; only its hash is
 * stored (minted_token_hash). A job whose agent was deleted meanwhile is
 * canceled instead of sent.
 */
export async function claimNextJob(hostId: string): Promise<ClaimedJob | null> {
    const canceled: RuntimeHostJobRow[] = [];
    const claimed = await db.transaction(async (tx) => {
        const heartbeatAge = await tx.execute(sql`
            SELECT (inventory_json->'heartbeat'->>'memAvailMiB')::int AS mem,
                   (now() - (inventory_json->'heartbeat'->>'at')::timestamptz) < interval '2 minutes' AS fresh
            FROM runtime_hosts WHERE id = ${hostId}`);
        const beat = (heartbeatAge.rows[0] ?? {}) as { mem?: number | null; fresh?: boolean | null };
        const [host] = await tx.select({ id: runtimeHosts.id, inventoryJson: runtimeHosts.inventoryJson }).from(runtimeHosts)
            .where(and(eq(runtimeHosts.id, hostId), isNull(runtimeHosts.revokedAt))).for("update");
        if (!host) return null;
        const runs = hostCommandsFrom((host.inventoryJson as { commands?: unknown } | null)?.commands);
        const [busy] = await tx.select({ id: runtimeHostJobs.id }).from(runtimeHostJobs)
            .where(and(eq(runtimeHostJobs.hostId, hostId), inArray(runtimeHostJobs.status, ["sent", "running"]))).limit(1);
        if (busy) return null;
        for (let i = 0; i < 5; i++) {
            const [next] = await tx.select().from(runtimeHostJobs)
                .where(and(eq(runtimeHostJobs.hostId, hostId), eq(runtimeHostJobs.status, "queued"), inArray(runtimeHostJobs.command, runs)))
                .orderBy(asc(runtimeHostJobs.createdAt)).limit(1);
            if (!next) return null;
            let sendArgs: Record<string, unknown> | null = null;
            let mintedTokenHash: string | undefined;
            if (next.command === "provision_agent") {
                // The agent row stays share-locked until the token is stored: a concurrent delete
                // waits and then revokes it, or it won and this job is canceled. A row another
                // transaction holds right now is skipped (never waited on: the host row is locked
                // here, and inventory locks agents before hosts); the job is dispatched on the next nudge.
                const [agent] = next.agentId
                    ? await tx.select({ id: agents.id, deletedAt: agents.deletedAt }).from(agents).where(eq(agents.id, next.agentId))
                        .for("share", { skipLocked: true }).limit(1)
                    : [];
                if (!agent && next.agentId) {
                    const [exists] = await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, next.agentId)).limit(1);
                    if (exists) return null;
                }
                if (!agent || agent.deletedAt) {
                    const [gone] = await tx.update(runtimeHostJobs).set({ status: "canceled", error: "the agent was deleted", finishedAt: sql`now()`, updatedAt: sql`now()` })
                        .where(and(eq(runtimeHostJobs.id, next.id), eq(runtimeHostJobs.status, "queued"))).returning();
                    if (gone) canceled.push(gone);
                    continue;
                }
                // Memory may have gone since the hire: a fresh heartbeat (< 2 min) that is short fails it clearly.
                const gateway = ((next.argsJson ?? {}) as { gateway?: string }).gateway === "shared" ? "shared" : "standalone";
                const need = PROVISION_MEMORY_MIB[gateway];
                if (beat.fresh && typeof beat.mem === "number" && beat.mem < need) {
                    const [short] = await tx.update(runtimeHostJobs).set({
                        status: "failed", error: `Not enough free memory on the host now (${beat.mem} MB free, a new agent needs ${need} MB)`,
                        finishedAt: sql`now()`, updatedAt: sql`now()`,
                    }).where(and(eq(runtimeHostJobs.id, next.id), eq(runtimeHostJobs.status, "queued"))).returning();
                    if (short) canceled.push(short);
                    continue;
                }
                const minted = await mintAgentRuntimeToken({ companyId: next.companyId, agentId: agent.id, name: hostProvisionTokenName(next.id), executor: tx });
                const checked = validateCommandArgs("provision_agent", { ...(next.argsJson as Record<string, unknown>), apiToken: minted.rawToken }, { stage: "dispatch" });
                if (!checked.ok) throw new Error(`provision job ${next.id} has invalid arguments: ${checked.error}`);
                sendArgs = checked.args;
                mintedTokenHash = minted.tokenHash;
            }
            const deadlineSec = isHostCommand(next.command) ? COMMAND_DEADLINE_SEC[next.command] : 300;
            const [sent] = await tx.update(runtimeHostJobs).set({
                status: "sent",
                attempts: sql`${runtimeHostJobs.attempts} + 1`,
                sentAt: sql`now()`,
                updatedAt: sql`now()`,
                deadlineAt: sql`now() + make_interval(secs => ${deadlineSec})`,
                ...(mintedTokenHash ? { mintedTokenHash } : {}),
            }).where(and(eq(runtimeHostJobs.id, next.id), eq(runtimeHostJobs.status, "queued"))).returning();
            return sent ? { job: sent, sendArgs } : null;
        }
        return null;
    });
    for (const job of canceled) await auditJobFinished(job);
    return claimed;
}

/** Agents whose latest provision job on this host is not (yet) succeeded. */
async function agentsBeingProvisioned(hostId: string, executor: Pick<typeof db, "execute"> = db): Promise<string[]> {
    const rows = await executor.execute(sql`
        SELECT agent_id, status FROM (
            SELECT DISTINCT ON (agent_id) agent_id, status FROM runtime_host_jobs
            WHERE host_id = ${hostId} AND command = 'provision_agent' AND agent_id IS NOT NULL
            ORDER BY agent_id, created_at DESC
        ) latest WHERE status <> 'succeeded'`);
    return (rows.rows as { agent_id: string }[]).map((r) => r.agent_id);
}

/** Agents with a removal still to run on this host. */
async function agentsBeingRemoved(hostId: string, executor: Pick<typeof db, "select"> = db): Promise<string[]> {
    const rows = await executor.select({ agentId: runtimeHostJobs.agentId }).from(runtimeHostJobs).where(and(
        eq(runtimeHostJobs.hostId, hostId), eq(runtimeHostJobs.command, "remove_agent"), inArray(runtimeHostJobs.status, ["queued", "sent", "running"]),
    ));
    return rows.map((r) => r.agentId).filter((id): id is string => Boolean(id));
}

/**
 * The tokens of a finished provision job. Succeeded: the agent keeps the one
 * token the host wrote (reported as tokenSha256 when it is one of this job's,
 * else the last one minted) and every other host-provision token of the agent
 * is revoked. Any other end: every token minted for this job is revoked.
 */
async function settleJobTokens(job: RuntimeHostJobRow, reportedSha256: string | null | undefined, executor: Executor): Promise<void> {
    if (job.command !== "provision_agent" || !job.agentId) return;
    if (job.status === "succeeded") {
        let keep = job.mintedTokenHash;
        if (reportedSha256 && reportedSha256 !== keep) {
            const [ours] = await executor.select({ id: companyTokens.id }).from(companyTokens).where(and(
                eq(companyTokens.agentId, job.agentId), eq(companyTokens.tokenHash, reportedSha256), eq(companyTokens.name, hostProvisionTokenName(job.id)),
            )).limit(1);
            if (ours) keep = reportedSha256;
        }
        await revokeAgentRuntimeTokens(job.agentId, { nameLike: `${HOST_PROVISION_TOKEN_PREFIX}%`, keepTokenHash: keep ?? undefined, executor });
        return;
    }
    if (["failed", "timed_out", "canceled", "lost"].includes(job.status)) {
        await revokeAgentRuntimeTokens(job.agentId, { nameLike: hostProvisionTokenName(job.id), executor });
    }
}

/** After a job succeeded: the agent it set up runs on this host; the agent it removed no longer does. */
async function applyJobOutcome(job: RuntimeHostJobRow, executor: Executor): Promise<void> {
    if (job.status !== "succeeded" || !job.agentId) return;
    const args = (job.argsJson ?? {}) as { profile?: string };
    if (job.command === "provision_agent" && args.profile) {
        await executor.update(agents).set({ runtimeHostId: job.hostId, runtimeProfile: args.profile })
            .where(and(eq(agents.id, job.agentId), eq(agents.companyId, job.companyId), isNull(agents.deletedAt)));
    } else if (job.command === "remove_agent") {
        await executor.update(agents).set({ runtimeHostId: null })
            .where(and(eq(agents.id, job.agentId), eq(agents.companyId, job.companyId), eq(agents.runtimeHostId, job.hostId)));
    }
}

/** Move a job by an event, only from the states the event applies to. */
async function transition(jobId: string, hostId: string, event: JobEvent, extra: Partial<typeof runtimeHostJobs.$inferInsert> = {},
    reportedTokenSha256?: string | null): Promise<RuntimeHostJobRow | null> {
    const [job] = await db.select().from(runtimeHostJobs).where(and(eq(runtimeHostJobs.id, jobId), eq(runtimeHostJobs.hostId, hostId))).limit(1);
    if (!job) return null;
    const next = nextJobStatus(job.status as JobStatus, event);
    if (!next) return null;
    const terminal = ["succeeded", "failed", "timed_out", "canceled", "lost"].includes(next);
    // The status change, the job's tokens and the agent's host link move together.
    const updated = await db.transaction(async (tx) => {
        const [row] = await tx.update(runtimeHostJobs).set({
            status: next,
            updatedAt: sql`now()`,
            ...(next === "running" && !job.startedAt ? { startedAt: sql`now()` } : {}),
            ...(terminal ? { finishedAt: sql`now()` } : {}),
            ...(next === "queued" ? { sentAt: null, deadlineAt: null } : {}),
            ...extra,
        }).where(and(eq(runtimeHostJobs.id, jobId), eq(runtimeHostJobs.status, job.status), inArray(runtimeHostJobs.status, jobEventSources(event)))).returning();
        if (row && terminal) await settleJobOutcome(row, reportedTokenSha256, tx);
        return row;
    });
    if (updated && terminal) await auditJobFinished(updated);
    return updated ?? null;
}

/** A finished job's side effects, inside the transaction that finished it: tokens, then the host link. */
async function settleJobOutcome(job: RuntimeHostJobRow, reportedTokenSha256: string | null | undefined, tx: Executor): Promise<void> {
    await settleJobTokens(job, reportedTokenSha256, tx);
    await applyJobOutcome(job, tx);
}

/** A job reached its end: audited (its tokens and host link were settled with its status). */
async function auditJobFinished(job: RuntimeHostJobRow): Promise<void> {
    await recordAudit({
        companyId: job.companyId, actor: SYSTEM_ACTOR, action: "runtime_host.job_finished",
        target: { type: "runtime_host", id: job.hostId },
        after: { command: job.command, jobId: job.id, agentId: job.agentId, status: job.status },
    });
}

export async function applyAck(hostId: string, frame: AckFrame): Promise<RuntimeHostJobRow | null> {
    const [job] = await db.select({ attempts: runtimeHostJobs.attempts }).from(runtimeHostJobs).where(and(eq(runtimeHostJobs.id, frame.jobId), eq(runtimeHostJobs.hostId, hostId))).limit(1);
    if (!job) return null;
    const reason = redactHostText(frame.reason, 200);
    return transition(frame.jobId, hostId, { type: "ack", accepted: frame.accepted, reason, attempts: job.attempts },
        frame.accepted ? {} : { error: reason ?? "refused by the host" });
}

export async function applyProgress(hostId: string, frame: ProgressFrame): Promise<boolean> {
    const [job] = await db.select({ id: runtimeHostJobs.id, status: runtimeHostJobs.status }).from(runtimeHostJobs)
        .where(and(eq(runtimeHostJobs.id, frame.jobId), eq(runtimeHostJobs.hostId, hostId))).limit(1);
    if (!job || !["sent", "running"].includes(job.status)) return false;
    // Progress means the host is running it, even when the ack got lost.
    if (job.status === "sent") await transition(frame.jobId, hostId, { type: "ack", accepted: true, attempts: 0 });
    if (frame.seq > HOST_MAX_PROGRESS_EVENTS) {
        await db.update(runtimeHostJobs).set({ progressTruncated: true })
            .where(and(eq(runtimeHostJobs.id, frame.jobId), eq(runtimeHostJobs.progressTruncated, false)));
        return false;
    }
    const inserted = await db.insert(runtimeHostJobEvents).values({
        jobId: frame.jobId, seq: frame.seq, step: redactHostText(frame.step, 300), line: redactHostText(frame.line, 1000),
    }).onConflictDoNothing().returning({ id: runtimeHostJobEvents.id });
    return inserted.length > 0;
}

export async function applyResult(hostId: string, frame: ResultFrame): Promise<RuntimeHostJobRow | null> {
    const logTail = redactHostText(frame.logTail, HOST_LOG_TAIL_MAX);
    const summary = redactHostText(frame.summary, 500);
    return transition(frame.jobId, hostId, { type: "result", ok: frame.ok }, {
        resultJson: { ok: frame.ok, exitCode: frame.exitCode ?? null, errorCode: frame.errorCode ?? null, summary, logTail, units: frame.units ?? [] },
        error: frame.ok ? null : (summary || frame.errorCode || "failed"),
    }, frame.tokenSha256 ?? null);
}

/**
 * After a hello: line the server's view up with the host's. Jobs the host
 * still runs are running; jobs it finished are sent again so it replays the
 * stored result (it never runs a known job twice); jobs it never heard of
 * go back to the queue (sent) or are lost (running).
 */
export async function reconcileHostJobs(hostId: string, reported: HelloFrame["jobs"]): Promise<RuntimeHostJobRow[]> {
    const open = await db.select().from(runtimeHostJobs).where(and(eq(runtimeHostJobs.hostId, hostId), inArray(runtimeHostJobs.status, ["sent", "running"])));
    const byId = new Map(reported.map((j) => [j.jobId.toLowerCase(), j]));
    const resend: RuntimeHostJobRow[] = [];
    for (const job of open) {
        const known = byId.get(job.id);
        if (!known) {
            await transition(job.id, hostId, { type: "unknown_to_host", attempts: job.attempts }, { error: "the host did not know this job after reconnecting" });
        } else if (known.state === "running") {
            if (job.status === "sent") await transition(job.id, hostId, { type: "ack", accepted: true, attempts: job.attempts });
        } else {
            resend.push(job);
        }
    }
    return resend;
}

export async function getJob(companyId: string, jobId: string, afterSeq = 0): Promise<{ job: RuntimeHostJobRow; events: (typeof runtimeHostJobEvents.$inferSelect)[] } | null> {
    if (!UUID_RE.test(jobId)) return null;
    const [job] = await db.select().from(runtimeHostJobs).where(and(eq(runtimeHostJobs.id, jobId), eq(runtimeHostJobs.companyId, companyId))).limit(1);
    if (!job) return null;
    const events = await db.select().from(runtimeHostJobEvents)
        .where(and(eq(runtimeHostJobEvents.jobId, jobId), gt(runtimeHostJobEvents.seq, afterSeq)))
        .orderBy(asc(runtimeHostJobEvents.seq)).limit(500);
    return { job, events };
}

export async function listJobs(companyId: string, hostId: string, limit = 20): Promise<RuntimeHostJobRow[]> {
    return db.select().from(runtimeHostJobs).where(and(eq(runtimeHostJobs.companyId, companyId), eq(runtimeHostJobs.hostId, hostId)))
        .orderBy(desc(runtimeHostJobs.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
}

// ── sweeper ─────────────────────────────────────────────────────────────────

export type SweepResult = {
    offline: number; requeued: number; failed: number; timedOut: number; lost: number; expired: number; pruned: number; revokedTokens: number; nudge: string[];
};

/**
 * Every 30 s from server.ts, under an advisory lock so one instance sweeps:
 * silent hosts go offline, unacknowledged jobs go back to the queue (or fail
 * after 3 attempts), overdue jobs time out, jobs of long-gone hosts are lost,
 * stale queued jobs expire, hosts with queued work are nudged, and old
 * progress lines (30 days) and finished jobs (90 days) are pruned in batches.
 * Every time comparison uses the database clock.
 */
export async function sweepRuntimeHosts(): Promise<SweepResult | null> {
    const result = await db.transaction(async (tx) => {
        const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${HOST_SWEEP_LOCK}, 1) AS locked`);
        if (!(lock.rows[0] as { locked?: boolean } | undefined)?.locked) return null;
        const at = ago;

        const offline = await tx.update(runtimeHosts).set({ status: "offline", offlineReason: "silent" }).where(and(
            eq(runtimeHosts.status, "online"), isNull(runtimeHosts.revokedAt), sql`${runtimeHosts.lastSeenAt} < ${at(HOST_OFFLINE_AFTER_MS)}`,
        )).returning({ id: runtimeHosts.id, companyId: runtimeHosts.companyId, name: runtimeHosts.name });

        const requeued = await tx.update(runtimeHostJobs).set({ status: "queued", sentAt: null, deadlineAt: null, updatedAt: sql`now()` }).where(and(
            eq(runtimeHostJobs.status, "sent"), sql`${runtimeHostJobs.sentAt} < ${at(JOB_ACK_TIMEOUT_MS)}`, sql`${runtimeHostJobs.attempts} < ${MAX_JOB_ATTEMPTS}`,
        )).returning({ id: runtimeHostJobs.id, hostId: runtimeHostJobs.hostId });
        const failed = await tx.update(runtimeHostJobs).set({ status: "failed", error: "the host never acknowledged the job", finishedAt: sql`now()`, updatedAt: sql`now()` }).where(and(
            eq(runtimeHostJobs.status, "sent"), sql`${runtimeHostJobs.sentAt} < ${at(JOB_ACK_TIMEOUT_MS)}`, sql`${runtimeHostJobs.attempts} >= ${MAX_JOB_ATTEMPTS}`,
        )).returning();
        const timedOut = await tx.update(runtimeHostJobs).set({ status: "timed_out", error: "the job ran past its deadline", finishedAt: sql`now()`, updatedAt: sql`now()` }).where(and(
            eq(runtimeHostJobs.status, "running"), sql`${runtimeHostJobs.deadlineAt} < ${at(JOB_DEADLINE_GRACE_MS)}`,
        )).returning();
        const goneHost = sql`${runtimeHostJobs.hostId} IN (SELECT id FROM runtime_hosts WHERE status <> 'online' AND (last_seen_at IS NULL OR last_seen_at < ${at(JOB_LOST_AFTER_MS)}))`;
        const lost = await tx.update(runtimeHostJobs).set({ status: "lost", error: "the host has been offline too long", finishedAt: sql`now()`, updatedAt: sql`now()` }).where(and(
            inArray(runtimeHostJobs.status, ["sent", "running"]), notInArray(runtimeHostJobs.command, [...WAIT_FOR_HOST_COMMANDS]), goneHost,
        )).returning();
        // A removal waits for its host instead: back to the queue (the daemon replays it if it already ran).
        await tx.update(runtimeHostJobs).set({ status: "queued", sentAt: null, deadlineAt: null, updatedAt: sql`now()` }).where(and(
            inArray(runtimeHostJobs.status, ["sent", "running"]), inArray(runtimeHostJobs.command, [...WAIT_FOR_HOST_COMMANDS]), goneHost,
        ));
        const expired = await tx.update(runtimeHostJobs).set({ status: "canceled", error: "expired in the queue (the host was not reachable)", finishedAt: sql`now()`, updatedAt: sql`now()` }).where(and(
            eq(runtimeHostJobs.status, "queued"), notInArray(runtimeHostJobs.command, [...WAIT_FOR_HOST_COMMANDS]), sql`${runtimeHostJobs.createdAt} < ${at(JOB_QUEUE_EXPIRY_MS)}`,
        )).returning();
        for (const job of [...failed, ...timedOut, ...lost, ...expired]) await settleJobOutcome(job, null, tx);
        // Belt and braces: no provisioning token outlives a job that did not succeed, or its agent.
        const orphanTokens = await tx.execute(sql`
            UPDATE company_tokens t SET revoked_at = now()
            WHERE t.revoked_at IS NULL AND t.name LIKE ${`${HOST_PROVISION_TOKEN_PREFIX}%`} AND (
                EXISTS (SELECT 1 FROM agents a WHERE a.id = t.agent_id AND a.deleted_at IS NOT NULL)
                OR EXISTS (SELECT 1 FROM runtime_host_jobs j WHERE j.id::text = substring(t.name from ${HOST_PROVISION_TOKEN_PREFIX.length + 1}::int)
                           AND j.status IN ('failed', 'timed_out', 'canceled', 'lost')))`);
        await tx.delete(runtimeHostPairings).where(sql`${runtimeHostPairings.expiresAt} < ${at(24 * 3600_000)}`);
        const prunedEvents = await tx.execute(sql`
            DELETE FROM runtime_host_job_events WHERE id IN (
                SELECT id FROM runtime_host_job_events WHERE at < ${at(EVENT_RETENTION_MS)} LIMIT ${RETENTION_BATCH})`);
        const prunedJobs = await tx.execute(sql`
            DELETE FROM runtime_host_jobs WHERE id IN (
                SELECT id FROM runtime_host_jobs
                WHERE status IN ('succeeded', 'failed', 'timed_out', 'canceled', 'lost') AND finished_at < ${at(JOB_RETENTION_MS)}
                LIMIT ${RETENTION_BATCH})`);
        const waiting = await tx.execute(sql`
            SELECT DISTINCT j.host_id FROM runtime_host_jobs j JOIN runtime_hosts h ON h.id = j.host_id
            WHERE j.status = 'queued' AND h.status = 'online' AND h.revoked_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM runtime_host_jobs b WHERE b.host_id = j.host_id AND b.status IN ('sent', 'running'))`);
        const pruned = (prunedEvents.rowCount ?? 0) + (prunedJobs.rowCount ?? 0);
        return {
            offline, requeued, failed, timedOut, lost, expired, pruned, revokedTokens: orphanTokens.rowCount ?? 0,
            waiting: (waiting.rows as { host_id: string }[]).map((r) => r.host_id),
        };
    });
    if (!result) return null;
    for (const job of [...result.failed, ...result.timedOut, ...result.lost, ...result.expired]) await auditJobFinished(job);
    if (result.offline.length > 0) {
        await recordAudits(result.offline.map((h): RecordAuditInput => ({
            companyId: h.companyId, actor: SYSTEM_ACTOR, action: "runtime_host.disconnected",
            target: { type: "runtime_host", id: h.id }, after: { name: h.name, status: "offline" }, meta: { via: "silent" },
        })));
    }
    const nudge = [...new Set([...result.requeued.map((j) => j.hostId), ...result.waiting])];
    for (const hostId of nudge) await notifyHost({ kind: "job", hostId });
    return {
        offline: result.offline.length, requeued: result.requeued.length, failed: result.failed.length, timedOut: result.timedOut.length,
        lost: result.lost.length, expired: result.expired.length, pruned: result.pruned, revokedTokens: result.revokedTokens, nudge,
    };
}

// ── agents on hosts (0.22) ──────────────────────────────────────────────────

/** The commands a host's daemon runs (0.21 daemons advertise none: restart + refresh). */
export function hostCommandsOf(host: Pick<RuntimeHostRow, "inventoryJson">): HostCommand[] {
    return hostCommandsFrom((host.inventoryJson as { commands?: unknown } | null)?.commands);
}

/** Profile names on a host or promised to an agent there (a new agent's profile must be none of them). */
export async function takenProfiles(host: RuntimeHostRow): Promise<string[]> {
    const reported = ((host.inventoryJson as { profiles?: { profile?: string }[] } | null)?.profiles ?? []).map((p) => p.profile ?? "");
    const onHost = await db.select({ profile: agents.runtimeProfile }).from(agents).where(eq(agents.runtimeHostId, host.id));
    const pending = await db.select({ args: runtimeHostJobs.argsJson }).from(runtimeHostJobs).where(and(
        eq(runtimeHostJobs.hostId, host.id), eq(runtimeHostJobs.command, "provision_agent"), ne(runtimeHostJobs.status, "canceled"),
    ));
    return [...reported, ...onHost.map((a) => a.profile ?? ""), ...pending.map((j) => String((j.args as { profile?: string }).profile ?? ""))].filter(Boolean);
}

/** The agent's latest provision job (its setup on a host), or null. */
export async function latestProvisionJob(companyId: string, agentId: string): Promise<RuntimeHostJobRow | null> {
    const [job] = await db.select().from(runtimeHostJobs).where(and(
        eq(runtimeHostJobs.companyId, companyId), eq(runtimeHostJobs.agentId, agentId), eq(runtimeHostJobs.command, "provision_agent"),
    )).orderBy(desc(runtimeHostJobs.createdAt)).limit(1);
    return job ?? null;
}

/** Cancel the agent's queued jobs (it is being deleted): their tokens are settled, nothing runs for it any more. */
export async function cancelQueuedJobsForAgent(companyId: string, agentId: string, reason: string): Promise<RuntimeHostJobRow[]> {
    const canceled = await db.transaction(async (tx) => {
        const rows = await tx.update(runtimeHostJobs).set({ status: "canceled", error: reason, finishedAt: sql`now()`, updatedAt: sql`now()` }).where(and(
            eq(runtimeHostJobs.companyId, companyId), eq(runtimeHostJobs.agentId, agentId), eq(runtimeHostJobs.status, "queued"),
            ne(runtimeHostJobs.command, "remove_agent"),
        )).returning();
        for (const job of rows) await settleJobOutcome(job, null, tx);
        return rows;
    });
    for (const job of canceled) await auditJobFinished(job);
    return canceled;
}

/** Free memory (MiB) the host's queued and running setups will take: a new hire must fit beside them. */
export async function pendingProvisionMiB(hostId: string): Promise<number> {
    const rows = await db.select({ args: runtimeHostJobs.argsJson }).from(runtimeHostJobs).where(and(
        eq(runtimeHostJobs.hostId, hostId), eq(runtimeHostJobs.command, "provision_agent"), inArray(runtimeHostJobs.status, ["queued", "sent", "running"]),
    ));
    return rows.reduce((sum, r) => sum + PROVISION_MEMORY_MIB[(r.args as { gateway?: string }).gateway === "shared" ? "shared" : "standalone"], 0);
}

// ── removals an admin follows up (0.22) ─────────────────────────────────────

export class JobActionError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

const FAILED_STATUSES = ["failed", "timed_out", "canceled", "lost"];

async function removalJob(companyId: string, jobId: string): Promise<RuntimeHostJobRow> {
    if (!UUID_RE.test(jobId)) throw new JobActionError(404, "Job not found");
    const [job] = await db.select().from(runtimeHostJobs).where(and(eq(runtimeHostJobs.id, jobId), eq(runtimeHostJobs.companyId, companyId))).limit(1);
    if (!job) throw new JobActionError(404, "Job not found");
    if (job.command !== "remove_agent") throw new JobActionError(400, "Only removals can be retried, dismissed or canceled here");
    return job;
}

async function markDismissed(jobId: string, userId: string): Promise<void> {
    await db.update(runtimeHostJobs).set({
        resultJson: sql`coalesce(${runtimeHostJobs.resultJson}, '{}'::jsonb) || ${JSON.stringify({ dismissedAt: new Date().toISOString(), dismissedBy: userId })}::jsonb`,
    }).where(eq(runtimeHostJobs.id, jobId));
}

/** A failed removal is acknowledged: it leaves the host card (the audit keeps it). */
export async function dismissRemoval(companyId: string, jobId: string, userId: string): Promise<RuntimeHostJobRow> {
    const job = await removalJob(companyId, jobId);
    if (!FAILED_STATUSES.includes(job.status)) throw new JobActionError(409, "Only a removal that did not succeed can be dismissed");
    await markDismissed(job.id, userId);
    await recordAudit({
        companyId, actor: humanActor(userId), action: "runtime_host.job_dismissed",
        target: { type: "runtime_host", id: job.hostId }, after: { command: job.command, jobId: job.id, agentId: job.agentId, profile: (job.argsJson as { profile?: string }).profile },
    });
    return job;
}

/** Run a failed removal again (a new job; the old one is dismissed). */
export async function retryRemoval(companyId: string, jobId: string, userId: string): Promise<RuntimeHostJobRow> {
    const job = await removalJob(companyId, jobId);
    if (!FAILED_STATUSES.includes(job.status)) throw new JobActionError(409, "Only a removal that did not succeed can be retried");
    const host = await getHost(companyId, job.hostId);
    if (!host || host.revokedAt) throw new JobActionError(409, "The host was revoked: remove the profile on the machine by hand");
    const queued = await queueJob({
        companyId, hostId: job.hostId, agentId: job.agentId, command: "remove_agent", args: job.argsJson as Record<string, unknown>,
        idempotencyKey: `remove:${job.agentId ?? job.id}:retry:${job.id}`, userId,
    });
    if (queued.conflict) throw new JobActionError(409, "This removal was already retried differently");
    await markDismissed(job.id, userId);
    return queued.job;
}

/** Cancel a removal that has not started: the agent's profile stays on the machine (audited). */
export async function cancelRemoval(companyId: string, jobId: string, userId: string): Promise<RuntimeHostJobRow> {
    const job = await removalJob(companyId, jobId);
    const canceled = await transition(job.id, job.hostId, { type: "cancel" }, { error: "canceled by an admin: the profile stays on the machine" });
    if (!canceled) throw new JobActionError(409, "Only a removal still waiting for its host can be canceled");
    await markDismissed(job.id, userId);
    await recordAudit({
        companyId, actor: humanActor(userId), action: "runtime_host.removal_canceled",
        target: { type: "runtime_host", id: job.hostId }, after: { jobId: job.id, agentId: job.agentId, profile: (job.argsJson as { profile?: string }).profile },
    });
    return canceled;
}

/** Live host-provision tokens of an agent (tests and the agent page). */
export async function liveHostProvisionTokens(agentId: string): Promise<{ tokenHash: string; name: string }[]> {
    return db.select({ tokenHash: companyTokens.tokenHash, name: companyTokens.name }).from(companyTokens).where(and(
        eq(companyTokens.agentId, agentId), like(companyTokens.name, `${HOST_PROVISION_TOKEN_PREFIX}%`), isNull(companyTokens.revokedAt),
    ));
}

// ── serialization ───────────────────────────────────────────────────────────

export function serializeJob(job: RuntimeHostJobRow) {
    return {
        id: job.id, hostId: job.hostId, agentId: job.agentId, command: job.command, args: job.argsJson, status: job.status,
        attempts: job.attempts, error: job.error, result: job.resultJson, progressTruncated: job.progressTruncated,
        createdAt: job.createdAt, sentAt: job.sentAt, startedAt: job.startedAt, finishedAt: job.finishedAt, deadlineAt: job.deadlineAt,
    };
}
