// Agents and their runtime hosts (0.22): hire onto a host (provision_agent),
// retry a failed setup, and remove an agent's profile when it is deleted
// (remove_agent). Owners/admins only (the routes check); every job is
// audited by queueJob. Tokens are never handled here: provision_agent's
// token is minted when the job is sent (store.claimNextJob).

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, runtimeHosts } from "@/db/schema";
import { HOST_PROVISION_TOKEN_PREFIX, revokeAgentRuntimeTokens } from "@/lib/agent-runtime-tokens";
import {
    DEFAULT_HOST_MODEL, hostSupports, isHostLlmProvider, isSafeEnvValue, isValidHostModel, planHostCommand, profileSlugForAgent,
    type HostLlmProvider,
} from "./commands";
import { hireReadiness } from "./hire";
import { JOB_QUEUE_EXPIRY_MS, isTerminalJobStatus } from "./job-state";
import { hireFactsOf } from "./serialize";
import {
    getHost, hostCommandsOf, latestProvisionJob, pendingProvisionMiB, queueJob, takenProfiles, type RuntimeHostJobRow, type RuntimeHostRow,
} from "./store";

export class HostJobError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

export type HostedHireChoice = {
    host: RuntimeHostRow;
    llmProvider: HostLlmProvider;
    model: string;
    gateway: "standalone" | "shared";
    skipBrowser: boolean;
};

/** The longest agent name a host profile .env takes. */
export const HOSTED_AGENT_NAME_MAX = 80;

/**
 * Check a hire onto a host before anything is created: the host is live,
 * online, runs provision_agent, has a key for the provider and enough free
 * memory; the model is valid (the provider's default when empty); the name
 * fits a .env value. Throws HostJobError with the reason the UI shows.
 */
export async function checkHostedHire(companyId: string, input: { runtimeHostId: unknown; llmProvider: unknown; model: unknown; name: string }): Promise<HostedHireChoice> {
    const host = typeof input.runtimeHostId === "string" ? await getHost(companyId, input.runtimeHostId) : null;
    if (!host) throw new HostJobError(404, "Host not found");
    if (host.revokedAt) throw new HostJobError(409, `${host.name} was revoked: connect it again, then try again`);
    // Setups already queued there take their share of its memory first.
    const readiness = hireReadiness(hireFactsOf(host, await pendingProvisionMiB(host.id)));
    if (!readiness.ok) throw new HostJobError(409, `${host.name}: ${readiness.reason}`);
    if (!isHostLlmProvider(input.llmProvider) || !readiness.providers.includes(input.llmProvider)) {
        throw new HostJobError(400, `${host.name} has no key for that model provider. Available: ${readiness.providers.join(", ")}`);
    }
    const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : DEFAULT_HOST_MODEL[input.llmProvider];
    if (!isValidHostModel(model)) throw new HostJobError(400, "The model name may only use letters, digits and . _ : / -");
    if (!input.name || input.name.length > HOSTED_AGENT_NAME_MAX || !isSafeEnvValue(input.name)) {
        throw new HostJobError(400, `For an agent on a host the name must be at most ${HOSTED_AGENT_NAME_MAX} characters, without quotes, backslashes, $ or backticks`);
    }
    return { host, llmProvider: input.llmProvider, model, gateway: readiness.gateway, skipBrowser: readiness.skipBrowser };
}

/**
 * Queue the setup of `agent` on the chosen host: a free profile name derived
 * from the agent's name, the agent linked to the host (so it shows "Setting
 * up on <host>" and can be removed from there), then provision_agent. When
 * queueing fails the link is put back as it was.
 */
export async function queueAgentProvision(input: {
    companyId: string;
    userId: string;
    agent: { id: string; name: string };
    choice: HostedHireChoice;
    profile?: string | null;
    idempotencyKey: string;
}): Promise<RuntimeHostJobRow> {
    const { host } = input.choice;
    const profile = input.profile || profileSlugForAgent(input.agent.name, await takenProfiles(host));
    const plan = planHostCommand("provision_agent", {
        profile, agentId: input.agent.id, agentName: input.agent.name, gateway: input.choice.gateway,
        llmProvider: input.choice.llmProvider, model: input.choice.model, skipBrowser: input.choice.skipBrowser,
    }, { hostCommands: hostCommandsOf(host) });
    if (!plan.ok) throw new HostJobError(plan.status, plan.error);
    // Linked before the job exists (its dispatch must not wait on this row); a failed queue
    // undoes the link, and a new hire is deleted again by POST /api/agents.
    const [before] = await db.select({ runtimeHostId: agents.runtimeHostId, runtimeProfile: agents.runtimeProfile }).from(agents)
        .where(eq(agents.id, input.agent.id)).limit(1);
    await db.update(agents).set({ runtimeHostId: host.id, runtimeProfile: profile, deploymentMode: "remote" })
        .where(and(eq(agents.id, input.agent.id), eq(agents.companyId, input.companyId), isNull(agents.deletedAt)));
    try {
        const queued = await queueJob({
            companyId: input.companyId, hostId: host.id, agentId: input.agent.id, command: plan.command, args: plan.args,
            idempotencyKey: input.idempotencyKey, userId: input.userId,
        });
        if (queued.conflict) throw new HostJobError(409, "This hire was already queued differently");
        return queued.job;
    } catch (error) {
        await db.update(agents).set({ runtimeHostId: before?.runtimeHostId ?? null, runtimeProfile: before?.runtimeProfile ?? null })
            .where(eq(agents.id, input.agent.id)).catch(() => undefined);
        throw error;
    }
}

export type ProvisionState = {
    jobId: string;
    status: string;
    error: string | null;
    hostId: string;
    hostName: string | null;
    /** online / offline / revoked: a queued setup on an offline host waits ("expires in N min"). */
    hostStatus: string | null;
    profile: string | null;
    createdAt: Date;
    finishedAt: Date | null;
    /** When a still-queued setup is dropped if the host never comes back. */
    expiresAt: Date | null;
};

/**
 * The agent's latest setup on a host, whether or not it is still linked to
 * that host (a revoke or re-pair clears the link but the failed setup must
 * still say "Setup failed").
 */
export async function provisionStateFor(companyId: string, agentId: string): Promise<ProvisionState | null> {
    const job = await latestProvisionJob(companyId, agentId);
    if (!job) return null;
    const [host] = await db.select({ name: runtimeHosts.name, status: runtimeHosts.status, revokedAt: runtimeHosts.revokedAt })
        .from(runtimeHosts).where(eq(runtimeHosts.id, job.hostId)).limit(1);
    return {
        jobId: job.id, status: job.status, error: job.error, hostId: job.hostId, hostName: host?.name ?? null,
        hostStatus: host ? (host.revokedAt ? "revoked" : host.status) : null,
        profile: ((job.argsJson ?? {}) as { profile?: string }).profile ?? null, createdAt: job.createdAt, finishedAt: job.finishedAt,
        expiresAt: job.status === "queued" ? new Date(job.createdAt.getTime() + JOB_QUEUE_EXPIRY_MS) : null,
    };
}

/** "Setup failed" on the agent page: its latest setup on a host ended in anything but success. */
export function provisionFailed(job: Pick<RuntimeHostJobRow, "status"> | null): boolean {
    return Boolean(job && isTerminalJobStatus(job.status) && job.status !== "succeeded");
}

/**
 * Retry a failed setup on the agent's host: a new provision job (its token is
 * minted when it is sent; every token of the earlier attempts is revoked now).
 * The same profile is kept, so the host reruns it idempotently.
 */
export async function retryAgentProvision(companyId: string, userId: string, agentId: string): Promise<RuntimeHostJobRow> {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))).limit(1);
    if (!agent) throw new HostJobError(404, "Agent not found");
    const latest = await latestProvisionJob(companyId, agentId);
    // The host it was being set up on, even when a revoke or re-pair cleared the link.
    const hostId = agent.runtimeHostId ?? latest?.hostId ?? null;
    if (!hostId) throw new HostJobError(409, "This agent is not set up on a host");
    if (latest && !provisionFailed(latest)) {
        throw new HostJobError(409, latest.status === "succeeded" ? "This agent's setup already succeeded" : "Its setup is still running");
    }
    const choice = await checkHostedHire(companyId, {
        runtimeHostId: hostId, llmProvider: agent.llmProvider, model: agent.llmModel ?? undefined, name: agent.name,
    });
    await revokeAgentRuntimeTokens(agentId, { nameLike: `${HOST_PROVISION_TOKEN_PREFIX}%` });
    const profile = agent.runtimeProfile ?? ((latest?.argsJson ?? {}) as { profile?: string }).profile ?? null;
    return queueAgentProvision({
        companyId, userId, agent: { id: agent.id, name: agent.name }, choice, profile,
        idempotencyKey: `${agent.id}:retry:${latest?.id ?? "none"}`,
    });
}

export type HostRemoval =
    | { status: "queued"; jobId: string; hostId: string; hostName: string; hostOnline: boolean; needsUpdate: boolean }
    | { status: "not_on_host" | "host_gone" | "admin_required" | "skipped" };

/**
 * After an agent was deleted in Emperor (its tokens are already revoked, so
 * it cannot act): queue the removal of its profile on its host. The job never
 * expires in the queue: it runs when the host is back (or updated, for a 0.21
 * host), unless the host is revoked. Without a live host link there is
 * nothing to do on a host.
 */
export async function queueAgentRemoval(input: {
    companyId: string;
    userId: string;
    agent: { id: string; runtimeHostId: string | null; runtimeProfile: string | null };
}): Promise<HostRemoval> {
    const { agent } = input;
    if (!agent.runtimeHostId || !agent.runtimeProfile) return { status: "not_on_host" };
    const host = await getHost(input.companyId, agent.runtimeHostId);
    if (!host || host.revokedAt) return { status: "host_gone" };
    const plan = planHostCommand("remove_agent", { profile: agent.runtimeProfile, agentId: agent.id, purge: true });
    if (!plan.ok) throw new HostJobError(plan.status, plan.error);
    const queued = await queueJob({
        companyId: input.companyId, hostId: host.id, agentId: agent.id, command: "remove_agent", args: plan.args,
        idempotencyKey: `remove:${agent.id}`, userId: input.userId,
    });
    if (queued.conflict) throw new HostJobError(409, "A different removal was already queued for this agent");
    return {
        status: "queued", jobId: queued.job.id, hostId: host.id, hostName: host.name, hostOnline: host.status === "online",
        needsUpdate: !hostSupports(hostCommandsOf(host), "remove_agent"),
    };
}
