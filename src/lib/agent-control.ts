import { db } from "@/db";
import { agents, runtimeNodes, threadMessages } from "@/db/schema";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ensureDirectThread, getDirectThreadForUser } from "@/lib/control-plane";
import { broadcastMcpEvent } from "@/lib/pubsub";
import type { AgentControlAction } from "@/lib/agent-control-command";
import { roleGte, type Role } from "@/lib/role-matrix";

/** A directThreadId the caller may not use (someone else's private thread, another agent's). */
export class DirectThreadNotAllowedError extends Error {
    constructor() {
        super("Direct thread not found");
    }
}

/** Bridge capability: kill honours `runtimeControl.scope == "thread"` (controls.py). */
export const THREAD_KILL_CAPABILITY = "thread-kill-v1";
/** Bridge capability entry carrying its real parallel-turn limit, e.g. "max-parallel-turns: 3". */
const MAX_PARALLEL_TURNS_PREFIX = "max-parallel-turns:";

/** What an agent's runtime can do, from its newest registered runtime node. */
export interface AgentRuntimeTraits {
    /** The runtime stops one private chat without touching the agent's other chats. */
    threadKill: boolean;
    /** How many chats the runtime answers at once; null when the runtime does not say (older bridge). */
    maxParallelTurns: number | null;
}

/** Pure: read `runtime_nodes.capabilities_json` (a list of strings; "key: value" entries carry values). */
export function parseRuntimeTraits(capabilities: unknown): AgentRuntimeTraits {
    const list = Array.isArray(capabilities) ? capabilities.filter((c): c is string => typeof c === "string") : [];
    let maxParallelTurns: number | null = null;
    for (const entry of list) {
        if (!entry.startsWith(MAX_PARALLEL_TURNS_PREFIX)) continue;
        const value = Number(entry.slice(MAX_PARALLEL_TURNS_PREFIX.length).trim());
        if (Number.isInteger(value) && value >= 1 && value <= 64) maxParallelTurns = value;
    }
    return { threadKill: list.includes(THREAD_KILL_CAPABILITY), maxParallelTurns };
}

/** The agent's newest registered runtime (same choice as the bridge badges in agent-activity.ts). */
export async function getAgentRuntimeTraits(companyId: string, agentId: string): Promise<AgentRuntimeTraits> {
    const [node] = await db.select({ capabilitiesJson: runtimeNodes.capabilitiesJson }).from(runtimeNodes).where(and(
        eq(runtimeNodes.companyId, companyId), eq(runtimeNodes.agentId, agentId), isNull(runtimeNodes.deletedAt),
    )).orderBy(desc(runtimeNodes.lastSeenAt)).limit(1);
    return parseRuntimeTraits(node?.capabilitiesJson);
}

/**
 * Runtime control scope. In a person's own private direct thread (private direct-chat mode),
 * Replace only touches that thread, and so does Kill when the runtime advertises
 * `thread-kill-v1`: other chats' queued work, running turns and session context are left
 * alone. An older runtime only knows an agent-wide kill, so Kill stays agent-wide there (the
 * chat says so, see `stopScope` in GET /api/chat). Shared and Operations threads, and an
 * explicit agent-wide request, keep the agent-wide behaviour.
 */
export function controlScopeFor(action: AgentControlAction, thread: { ownerUserId?: string | null },
    options: { threadKill?: boolean; agentWide?: boolean } = {}): "agent" | "thread" {
    if (options.agentWide || !thread.ownerUserId) return "agent";
    if (action === "replace") return "thread";
    return action === "kill" && options.threadKill ? "thread" : "agent";
}

/** The scope a Stop in this direct thread gets right now, plus the runtime's parallel-turn limit. */
export async function chatRuntimeInfo(companyId: string, agentId: string, thread: { ownerUserId?: string | null }) {
    const traits = await getAgentRuntimeTraits(companyId, agentId);
    return { stopScope: controlScopeFor("kill", thread, traits), maxParallelTurns: traits.maxParallelTurns };
}

type Executor = Pick<typeof db, "update">;

/**
 * Cancels the agent's open work (queued, seen or acting prompts and goal
 * requests): everywhere, or in one thread only with `threadId`. Returns the
 * cancelled rows so the caller can broadcast them. Shared by Stop/Replace and
 * by archiving a chat (lib/private-chats.ts).
 */
export async function cancelOpenAgentWork(tx: Executor, companyId: string, agentId: string, threadId: string | null) {
    return tx.update(threadMessages).set({ deliveryState: "cancelled" }).where(and(
        eq(threadMessages.companyId, companyId),
        inArray(threadMessages.deliveryState, ["queued", "seen", "acting"]),
        // Direct requests plus a team request this agent is actually handling.
        sql`(${threadMessages.targetAgentId} = ${agentId}::uuid OR (${threadMessages.senderType} = 'human' AND ${threadMessages.metadataJson}->>'executionActorId' = ${agentId}))`,
        sql`(${threadMessages.senderType} = 'human' OR ${threadMessages.metadataJson} ? 'runtimeGoalRequest')`,
        ...(threadId ? [eq(threadMessages.threadId, threadId)] : []),
    )).returning();
}

/**
 * Who may stop or replace an agent's work in EVERY chat (`scope: "agent"`):
 * company owners and admins, and the agent's own owner. Anyone else stops
 * only their own chat; an agent-wide Stop would cancel other people's work.
 */
export function mayControlAgentEverywhere(viewer: { userId: string; role: Role }, agent: { ownerUserId?: string | null }): boolean {
    return roleGte(viewer.role, "admin") || (Boolean(agent.ownerUserId) && agent.ownerUserId === viewer.userId);
}

/** mayControlAgentEverywhere for an agent by id (false when it does not exist). */
export async function canStopAgentEverywhere(viewer: { companyId: string; userId: string; role: Role }, agentId: string): Promise<boolean> {
    const [agent] = await db.select({ ownerUserId: agents.ownerUserId }).from(agents).where(and(
        eq(agents.companyId, viewer.companyId), eq(agents.id, agentId), isNull(agents.deletedAt),
    )).limit(1);
    return Boolean(agent) && mayControlAgentEverywhere(viewer, agent);
}

// Durable control messages use the existing inbox, but are never LLM prompts.
// Lock the agent row to serialize simultaneous operator commands.
export async function requestAgentControl(companyId: string, userId: string, agentId: string, action: AgentControlAction,
    prompt: string, directThreadId?: string | null, options: { agentWide?: boolean } = {}) {
    const [agent] = await db.select({ id: agents.id, provider: agents.provider }).from(agents).where(and(
        eq(agents.companyId, companyId), eq(agents.id, agentId), isNull(agents.deletedAt),
    )).limit(1);
    if (!agent) throw new Error("Agent not found");
    if (agent.provider !== "hermes") throw new Error("Runtime controls require a Hermes agent");
    const thread = directThreadId
        ? await getDirectThreadForUser(companyId, agentId, directThreadId, userId)
        : await ensureDirectThread(companyId, agentId, userId);
    if (!thread) throw new DirectThreadNotAllowedError();
    // Only a kill that could be thread-scoped needs to know what the runtime supports.
    const threadKill = action === "kill" && Boolean(thread.ownerUserId) && !options.agentWide
        && (await getAgentRuntimeTraits(companyId, agentId)).threadKill;
    const scope = controlScopeFor(action, thread, { threadKill, agentWide: options.agentWide });
    const messages = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM agents WHERE id = ${agentId}::uuid AND company_id = ${companyId}::uuid FOR NO KEY UPDATE`);
        const changed = [];
        if (action !== "queue") {
            changed.push(...await cancelOpenAgentWork(tx, companyId, agentId, scope === "thread" ? thread.id : null));
            const [command] = await tx.insert(threadMessages).values({
                companyId, threadId: thread.id, targetAgentId: agentId, senderType: "system", senderId: userId,
                text: action === "kill" ? (scope === "thread" ? "Stop requested for this chat; clear its pending prompts." : "Stop requested; clear pending prompts.") : "Replace requested; stop previous work and start the new prompt.",
                deliveryState: "queued",
                metadataJson: { runtimeControl: scope === "thread" ? { action, scope } : { action } },
            }).returning();
            changed.push(command);
        }
        if (action !== "kill") {
            const [message] = await tx.insert(threadMessages).values({
                companyId, threadId: thread.id, targetAgentId: agentId, senderType: "human", senderId: userId,
                text: prompt.trim(), deliveryState: "queued", metadataJson: { controlAction: action },
            }).returning();
            changed.push(message);
        }
        return changed;
    });
    for (const message of messages) broadcastMcpEvent(companyId, { type: "thread_message", threadId: message.threadId, message });
    return { thread, message: messages.at(-1), action, scope, status: action === "queue" ? "queued" : "requested" };
}
