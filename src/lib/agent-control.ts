import { db } from "@/db";
import { agents, threadMessages } from "@/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ensureDirectThread, getDirectThreadForUser } from "@/lib/control-plane";
import { broadcastMcpEvent } from "@/lib/pubsub";
import type { AgentControlAction } from "@/lib/agent-control-command";

/** A directThreadId the caller may not use (someone else's private thread, another agent's). */
export class DirectThreadNotAllowedError extends Error {
    constructor() {
        super("Direct thread not found");
    }
}

/**
 * Runtime control scope. Kill is always agent-wide. Replace in a person's own private direct
 * thread (private direct-chat mode) only touches that thread: other people's queued work and
 * running turns, and their session context, are left alone. Replace in a shared or Operations
 * thread keeps the agent-wide behaviour.
 */
export function controlScopeFor(action: AgentControlAction, thread: { ownerUserId?: string | null }): "agent" | "thread" {
    return action === "replace" && thread.ownerUserId ? "thread" : "agent";
}

// Durable control messages use the existing inbox, but are never LLM prompts.
// Lock the agent row to serialize simultaneous operator commands.
export async function requestAgentControl(companyId: string, userId: string, agentId: string, action: AgentControlAction,
    prompt: string, directThreadId?: string | null) {
    const [agent] = await db.select({ id: agents.id, provider: agents.provider }).from(agents).where(and(
        eq(agents.companyId, companyId), eq(agents.id, agentId), isNull(agents.deletedAt),
    )).limit(1);
    if (!agent) throw new Error("Agent not found");
    if (agent.provider !== "hermes") throw new Error("Runtime controls require a Hermes agent");
    const thread = directThreadId
        ? await getDirectThreadForUser(companyId, agentId, directThreadId, userId)
        : await ensureDirectThread(companyId, agentId, userId);
    if (!thread) throw new DirectThreadNotAllowedError();
    const scope = controlScopeFor(action, thread);
    const messages = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM agents WHERE id = ${agentId}::uuid AND company_id = ${companyId}::uuid FOR NO KEY UPDATE`);
        const changed = [];
        if (action !== "queue") {
            const cancelled = await tx.update(threadMessages).set({ deliveryState: "cancelled" }).where(and(
                eq(threadMessages.companyId, companyId),
                inArray(threadMessages.deliveryState, ["queued", "seen", "acting"]),
                // Direct requests plus a team request this agent is actually handling.
                sql`(${threadMessages.targetAgentId} = ${agentId}::uuid OR (${threadMessages.senderType} = 'human' AND ${threadMessages.metadataJson}->>'executionActorId' = ${agentId}))`,
                sql`(${threadMessages.senderType} = 'human' OR ${threadMessages.metadataJson} ? 'runtimeGoalRequest')`,
                ...(scope === "thread" ? [eq(threadMessages.threadId, thread.id)] : []),
            )).returning();
            changed.push(...cancelled);
            const [command] = await tx.insert(threadMessages).values({
                companyId, threadId: thread.id, targetAgentId: agentId, senderType: "system", senderId: userId,
                text: action === "kill" ? "Stop requested; clear pending prompts." : "Replace requested; stop previous work and start the new prompt.",
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
