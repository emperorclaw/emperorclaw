import crypto from "crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { agents, pairedWorkers } from "@/db/schema";
import { decryptSecretPayload, encryptSecretPayload } from "@/lib/secrets";
import { mintAgentSetupToken } from "@/lib/hermes-provisioning";
import { hermesSafeName } from "@/lib/hermes-names";

/**
 * Remote worker pairing: a host without a Docker socket (Render) pairs a Hermes
 * worker with an agent created during onboarding. The app is reached by a
 * constant-time pairing-secret check on POST /api/runtime/pair; assignment is
 * an atomic claim so two workers can never take the same agent, and the
 * agent-bound token is minted once and delivered exactly once.
 */

/** Whether pairing is configured (the endpoint is disabled when the secret is unset). */
export function pairingEnabled(env: Record<string, string | undefined> = process.env): boolean {
    return Boolean(env.EMPEROR_WORKER_PAIRING_SECRET?.trim());
}

/**
 * Constant-time comparison of two secrets. Both are hashed to a fixed length
 * first so `timingSafeEqual` never throws on a length mismatch (which would
 * leak the expected length) and the compare itself runs in constant time.
 */
export function constantTimeEqual(a: string, b: string): boolean {
    const ha = crypto.createHash("sha256").update(a, "utf8").digest();
    const hb = crypto.createHash("sha256").update(b, "utf8").digest();
    return crypto.timingSafeEqual(ha, hb);
}

/** An idle worker the pairing pool may hand an agent to. */
export interface IdleWorker {
    id: string;
    workerId: string;
    companyId: string | null;
    agentId: string | null;
    lastSeenAt: Date;
}

/**
 * Pick the idle worker to assign next: unbound (companyId null) or already
 * bound to this company, with no assigned agent, most recently seen first.
 * Pure — unit-tested directly.
 */
export function selectIdleWorker(workers: IdleWorker[], companyId: string): IdleWorker | null {
    const idle = workers
        .filter((w) => !w.agentId && (w.companyId === null || w.companyId === companyId))
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
    return idle[0] ?? null;
}

export interface PairDelivery {
    assigned: boolean;
    agentId?: string;
    agentName?: string;
    agentRole?: string;
    apiToken?: string;
    llmProvider?: string;
    llmModel?: string;
    llmApiKey?: string;
}

type PairAgent = { id: string; name: string; role: string | null; llmProvider: string | null; llmModel: string | null };

/** Shape the pairing response; secrets are only ever present on first delivery. */
export function buildPairResponse(input: {
    assigned: boolean;
    agent: PairAgent | null;
    apiToken?: string | null;
    llmApiKey?: string | null;
}): PairDelivery {
    if (!input.assigned || !input.agent) return { assigned: false };
    const delivery: PairDelivery = {
        assigned: true,
        agentId: input.agent.id,
        agentName: input.agent.name,
        agentRole: input.agent.role ?? "operator",
    };
    if (input.apiToken) delivery.apiToken = input.apiToken;
    if (input.agent.llmProvider) delivery.llmProvider = input.agent.llmProvider;
    if (input.agent.llmModel) delivery.llmModel = input.agent.llmModel;
    if (input.llmApiKey) delivery.llmApiKey = input.llmApiKey;
    return delivery;
}

/** Upsert a worker and record a heartbeat, returning its current row. */
export async function heartbeatWorker(workerId: string) {
    const [existing] = await db.select().from(pairedWorkers).where(eq(pairedWorkers.workerId, workerId)).limit(1);
    if (existing) {
        const [updated] = await db.update(pairedWorkers).set({ lastSeenAt: new Date() })
            .where(eq(pairedWorkers.id, existing.id)).returning();
        return updated ?? existing;
    }
    const [created] = await db.insert(pairedWorkers).values({ workerId }).returning();
    return created;
}

/** Idle paired workers available for this company (for the hire claim). */
export async function listIdleWorkers(companyId: string): Promise<IdleWorker[]> {
    const rows = await db.select().from(pairedWorkers)
        .where(and(isNull(pairedWorkers.agentId), or(isNull(pairedWorkers.companyId), eq(pairedWorkers.companyId, companyId))))
        .orderBy(desc(pairedWorkers.lastSeenAt));
    return rows.map((r) => ({ id: r.id, workerId: r.workerId, companyId: r.companyId, agentId: r.agentId, lastSeenAt: r.lastSeenAt }));
}

/**
 * Atomically claim an idle worker for a freshly-created remote_paired agent and
 * stash the minted raw token (encrypted) for exactly-once delivery. Returns
 * true only when this call won the claim — a concurrent claim leaves the other
 * caller with `false`.
 */
export async function claimWorkerForAgent(input: {
    workerId: string;
    companyId: string;
    agentId: string;
    rawToken: string;
}): Promise<boolean> {
    const encrypted = encryptSecretPayload({ token: input.rawToken });
    if (!encrypted) return false;
    // A conditional update: only an idle worker (no agent) that is unbound or
    // bound to this company can be claimed, and the update itself is atomic —
    // exactly one worker gets the agent.
    const [claimed] = await db.update(pairedWorkers).set({
        companyId: input.companyId,
        agentId: input.agentId,
        pendingTokenEncrypted: encrypted.encryptedSecret,
        lastSeenAt: new Date(),
    }).where(and(
        eq(pairedWorkers.workerId, input.workerId),
        isNull(pairedWorkers.agentId),
        or(isNull(pairedWorkers.companyId), eq(pairedWorkers.companyId, input.companyId)),
    )).returning({ id: pairedWorkers.id });
    return Boolean(claimed);
}

/**
 * Hire-time assignment for a remote_paired agent: mint its agent-bound token and
 * claim the most-idle worker. Returns the worker id on success, or null when no
 * idle worker is available (the caller then falls back to manual guidance).
 */
export async function assignAgentToIdleWorker(companyId: string, agent: { id: string; name: string }): Promise<string | null> {
    const idle = await listIdleWorkers(companyId);
    const pick = selectIdleWorker(idle, companyId);
    if (!pick) return null;
    const { rawToken } = await mintAgentSetupToken(companyId, hermesSafeName(agent.name), agent.id);
    const claimed = await claimWorkerForAgent({ workerId: pick.workerId, companyId, agentId: agent.id, rawToken });
    return claimed ? pick.workerId : null;
}

/**
 * The pairing payload for a worker's current assignment. On first delivery the
 * pending token is decrypted and cleared (exactly-once); on later polls the
 * assignment is re-delivered without secrets so the worker reuses its persisted
 * token and key. Returns `{ assigned: false }` when the worker has no agent.
 */
export async function deliverWorkerAssignment(worker: typeof pairedWorkers.$inferSelect): Promise<PairDelivery> {
    const agentId = worker.agentId;
    if (!agentId) return { assigned: false };
    const [agent] = await db.select().from(agents)
        .where(and(eq(agents.id, agentId), isNull(agents.deletedAt))).limit(1);
    if (!agent) return { assigned: false };

    let apiToken: string | null = null;
    let llmApiKey: string | null = null;
    if (worker.pendingTokenEncrypted) {
        try {
            const pending = decryptSecretPayload(worker.pendingTokenEncrypted) as { token?: string };
            apiToken = typeof pending?.token === "string" ? pending.token : null;
        } catch {
            apiToken = null;
        }
        // Clear the pending token whether or not decryption succeeded, so a
        // corrupted value cannot wedge delivery forever.
        await db.update(pairedWorkers).set({ pendingTokenEncrypted: null }).where(eq(pairedWorkers.id, worker.id));
    }
    if (apiToken && agent.llmApiKeyEncrypted) {
        try {
            const key = decryptSecretPayload(agent.llmApiKeyEncrypted) as { apiKey?: string };
            llmApiKey = typeof key?.apiKey === "string" ? key.apiKey : null;
        } catch {
            llmApiKey = null;
        }
    }

    return buildPairResponse({
        assigned: true,
        agent: { id: agent.id, name: agent.name, role: agent.role, llmProvider: agent.llmProvider, llmModel: agent.llmModel },
        apiToken,
        llmApiKey,
    });
}
