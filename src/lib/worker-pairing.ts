import crypto from "crypto";
import { and, asc, desc, eq, isNull, like, notExists, or } from "drizzle-orm";
import { db } from "@/db";
import { agents, companyTokens, pairedWorkers } from "@/db/schema";
import { decryptSecretPayload, encryptSecretPayload } from "@/lib/secrets";
import { hermesSafeName } from "@/lib/hermes-names";

/**
 * Remote worker pairing: a host without a Docker socket (Render) pairs a Hermes
 * worker with an agent created during onboarding. The app is reached by a
 * constant-time pairing-secret check on POST /api/runtime/pair; assignment is
 * an atomic claim so two workers can never take the same agent (and the
 * database enforces one worker per agent), and the agent-bound token is minted
 * once and delivered exactly once.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Deployment mode of an agent that runs on a paired remote worker. */
export const REMOTE_PAIRED_MODE = "remote_paired";
/** Suffix of the token name minted for a paired worker (so it can be revoked). */
const PAIRED_TOKEN_SUFFIX = "-paired-worker";

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
    /** Profile-safe name (what EMPEROR_CLAW_AGENT_NAME is for a local container). */
    agentName?: string;
    displayName?: string;
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
        agentName: hermesSafeName(input.agent.name),
        displayName: input.agent.name,
        agentRole: input.agent.role ?? "operator",
    };
    if (input.apiToken) delivery.apiToken = input.apiToken;
    if (input.agent.llmProvider) delivery.llmProvider = input.agent.llmProvider;
    if (input.agent.llmModel) delivery.llmModel = input.agent.llmModel;
    // The LLM key travels only together with a fresh token (first delivery).
    if (input.apiToken && input.llmApiKey) delivery.llmApiKey = input.llmApiKey;
    return delivery;
}

/** Upsert a worker and record a heartbeat, returning its current row. */
export async function heartbeatWorker(workerId: string) {
    const [row] = await db.insert(pairedWorkers).values({ workerId })
        .onConflictDoUpdate({ target: pairedWorkers.workerId, set: { lastSeenAt: new Date() } })
        .returning();
    return row;
}

/** Idle paired workers available for this company (for the hire claim). */
export async function listIdleWorkers(companyId: string): Promise<IdleWorker[]> {
    const rows = await db.select().from(pairedWorkers)
        .where(and(isNull(pairedWorkers.agentId), or(isNull(pairedWorkers.companyId), eq(pairedWorkers.companyId, companyId))))
        .orderBy(desc(pairedWorkers.lastSeenAt));
    return rows.map((r) => ({ id: r.id, workerId: r.workerId, companyId: r.companyId, agentId: r.agentId, lastSeenAt: r.lastSeenAt }));
}

function hashToken(rawToken: string): string {
    return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Inside a transaction: mint the agent-bound token, and bind `workerRowId` to
 * the agent with the token stashed (encrypted) for exactly-once delivery. The
 * update is conditional (worker still idle, same-or-no company), and the unique
 * index on agent_id rejects a second worker for the same agent — so a lost race
 * rolls back the whole transaction, token included. Returns false on a lost
 * race or when no master key is configured.
 */
async function bindWorkerInTx(tx: Tx, input: { workerRowId: string; companyId: string; agent: { id: string; name: string } }): Promise<boolean> {
    const rawToken = `ec_${crypto.randomBytes(24).toString("hex")}`;
    const encrypted = encryptSecretPayload({ token: rawToken });
    if (!encrypted) return false;
    const [claimed] = await tx.update(pairedWorkers).set({
        companyId: input.companyId,
        agentId: input.agent.id,
        pendingTokenEncrypted: encrypted.encryptedSecret,
    }).where(and(
        eq(pairedWorkers.id, input.workerRowId),
        isNull(pairedWorkers.agentId),
        or(isNull(pairedWorkers.companyId), eq(pairedWorkers.companyId, input.companyId)),
    )).returning({ id: pairedWorkers.id });
    if (!claimed) return false;
    await tx.insert(companyTokens).values({
        companyId: input.companyId,
        // Bound to its agent so the worker can never act as a sibling.
        agentId: input.agent.id,
        tokenHash: hashToken(rawToken),
        name: `${hermesSafeName(input.agent.name)}${PAIRED_TOKEN_SUFFIX}`,
        scope: "mcp_full",
    });
    return true;
}

/** Postgres unique_violation: another worker already holds this agent. */
function isUniqueViolation(error: unknown): boolean {
    const code = (error as { code?: string; cause?: { code?: string } } | null)?.code
        ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
    return code === "23505";
}

/**
 * Hire-time assignment for a remote_paired agent: atomically claim the most
 * recently seen idle worker of this company (or an unbound one) and mint its
 * agent-bound token. Returns the worker id on success, or null when no idle
 * worker is available — the agent then waits, and the next idle worker that
 * polls picks it up (see `deliverWorkerAssignment`).
 */
export async function assignAgentToIdleWorker(companyId: string, agent: { id: string; name: string }): Promise<string | null> {
    try {
        return await db.transaction(async (tx) => {
            const [pick] = await tx.select({ id: pairedWorkers.id, workerId: pairedWorkers.workerId }).from(pairedWorkers)
                .where(and(isNull(pairedWorkers.agentId), or(isNull(pairedWorkers.companyId), eq(pairedWorkers.companyId, companyId))))
                .orderBy(desc(pairedWorkers.lastSeenAt))
                .limit(1)
                .for("update", { skipLocked: true });
            if (!pick) return null;
            const bound = await bindWorkerInTx(tx, { workerRowId: pick.id, companyId, agent });
            return bound ? pick.workerId : null;
        });
    } catch (error) {
        if (isUniqueViolation(error)) return null;
        throw error;
    }
}

/**
 * Agents waiting for a worker: remote_paired Hermes agents (not deleted) that
 * no worker holds. Scoped to the worker's company once it is bound; an unbound
 * worker takes the oldest waiting agent and is bound to its company from then on.
 */
async function claimWaitingAgentInTx(tx: Tx, worker: { id: string; companyId: string | null }): Promise<boolean> {
    const holder = tx.select({ id: pairedWorkers.id }).from(pairedWorkers).where(eq(pairedWorkers.agentId, agents.id));
    const [waiting] = await tx.select({ id: agents.id, name: agents.name, companyId: agents.companyId }).from(agents)
        .where(and(
            eq(agents.provider, "hermes"),
            eq(agents.deploymentMode, REMOTE_PAIRED_MODE),
            isNull(agents.deletedAt),
            worker.companyId ? eq(agents.companyId, worker.companyId) : undefined,
            notExists(holder),
        ))
        .orderBy(asc(agents.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
    if (!waiting) return false;
    return bindWorkerInTx(tx, { workerRowId: worker.id, companyId: waiting.companyId, agent: waiting });
}

/** Revoke every token minted for paired workers of this agent. */
async function revokePairedTokensInTx(tx: Tx, agentId: string): Promise<void> {
    await tx.update(companyTokens).set({ revokedAt: new Date() }).where(and(
        eq(companyTokens.agentId, agentId),
        isNull(companyTokens.revokedAt),
        like(companyTokens.name, `%${PAIRED_TOKEN_SUFFIX}`),
    ));
}

/** What the worker reports about its current assignment on a poll. */
export interface PairReport {
    /** The agent the worker believes it runs (from its persisted state). */
    agentId?: string | null;
    /**
     * The worker cannot use its assignment: `token` is the token it holds and
     * the app rejected (revoked), or null when it lost its token (disk wiped,
     * delivery lost in transit).
     */
    release?: { token: string | null } | null;
}

/**
 * Handle one poll for a worker row and return its pairing payload.
 *
 * Runs in one transaction with the worker row locked, so concurrent polls for
 * the same worker serialize: the pending token is read and cleared atomically
 * and therefore delivered exactly once. Later polls re-deliver the assignment
 * without secrets so the worker reuses its persisted token and key.
 *
 * - Agent deleted (or moved to another company) → the worker is released and
 *   returns to the pool (its company binding stays).
 * - `release` with a token the app no longer accepts (revoked) → the worker is
 *   released; the agent stops being paired so it is not silently re-issued a
 *   token after an operator revoked it.
 * - `release` with no token (the worker lost it) → the agent's paired tokens
 *   are revoked and a fresh one is minted for this same worker, so a token
 *   never has two holders.
 * - Idle worker → claims the oldest agent waiting for a worker, if any.
 */
export async function deliverWorkerAssignment(worker: typeof pairedWorkers.$inferSelect, report: PairReport = {}): Promise<PairDelivery> {
    try {
        return await db.transaction(async (tx) => {
            const [row] = await tx.select().from(pairedWorkers).where(eq(pairedWorkers.id, worker.id)).limit(1).for("update");
            if (!row) return { assigned: false };

            let current = row;
            if (current.agentId) {
                const [agent] = await tx.select({ id: agents.id, companyId: agents.companyId, deletedAt: agents.deletedAt, name: agents.name })
                    .from(agents).where(eq(agents.id, current.agentId)).limit(1);
                const gone = !agent || agent.deletedAt !== null || (current.companyId !== null && agent.companyId !== current.companyId);
                const reportedAgent = report.agentId ?? null;
                const releaseRequested = Boolean(report.release) && reportedAgent === current.agentId;
                if (gone) {
                    await tx.update(pairedWorkers).set({ agentId: null, pendingTokenEncrypted: null }).where(eq(pairedWorkers.id, current.id));
                    current = { ...current, agentId: null, pendingTokenEncrypted: null };
                } else if (releaseRequested && !current.pendingTokenEncrypted) {
                    const presented = report.release?.token ?? null;
                    if (presented) {
                        // Only release when the presented token really is no longer
                        // accepted for this agent; a live token means the worker
                        // should keep running (or simply retry).
                        const [active] = await tx.select({ id: companyTokens.id }).from(companyTokens)
                            .where(and(eq(companyTokens.tokenHash, hashToken(presented)), eq(companyTokens.agentId, agent.id), isNull(companyTokens.revokedAt)))
                            .limit(1);
                        if (!active) {
                            await tx.update(pairedWorkers).set({ agentId: null, pendingTokenEncrypted: null }).where(eq(pairedWorkers.id, current.id));
                            await tx.update(agents).set({ deploymentMode: "remote" }).where(eq(agents.id, agent.id));
                            return { assigned: false };
                        }
                    } else {
                        // Lost token: rotate. Revoke the agent's paired tokens and
                        // re-bind this same worker with a freshly minted one.
                        await revokePairedTokensInTx(tx, agent.id);
                        await tx.update(pairedWorkers).set({ agentId: null }).where(eq(pairedWorkers.id, current.id));
                        const rebound = await bindWorkerInTx(tx, { workerRowId: current.id, companyId: agent.companyId, agent });
                        if (!rebound) return { assigned: false };
                        const [fresh] = await tx.select().from(pairedWorkers).where(eq(pairedWorkers.id, current.id)).limit(1);
                        if (fresh) current = fresh;
                    }
                }
            }

            if (!current.agentId) {
                const claimed = await claimWaitingAgentInTx(tx, current);
                if (!claimed) return { assigned: false };
                const [fresh] = await tx.select().from(pairedWorkers).where(eq(pairedWorkers.id, current.id)).limit(1);
                if (!fresh?.agentId) return { assigned: false };
                current = fresh;
            }

            const [agent] = await tx.select().from(agents)
                .where(and(eq(agents.id, current.agentId!), isNull(agents.deletedAt))).limit(1);
            if (!agent) return { assigned: false };

            let apiToken: string | null = null;
            let llmApiKey: string | null = null;
            if (current.pendingTokenEncrypted) {
                try {
                    const pending = decryptSecretPayload(current.pendingTokenEncrypted) as { token?: string };
                    apiToken = typeof pending?.token === "string" ? pending.token : null;
                } catch {
                    apiToken = null;
                }
                // Cleared in the same transaction that read it: exactly-once. A
                // corrupted value is cleared too so it cannot wedge delivery; the
                // worker then reports a lost token and gets a rotated one.
                await tx.update(pairedWorkers).set({ pendingTokenEncrypted: null }).where(eq(pairedWorkers.id, current.id));
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
        });
    } catch (error) {
        // Another worker won the agent in a race: this poll is simply unassigned.
        if (isUniqueViolation(error)) return { assigned: false };
        throw error;
    }
}
