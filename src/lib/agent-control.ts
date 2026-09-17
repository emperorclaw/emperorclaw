import { db } from "@/db";
import { agents, threadMessages } from "@/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ensureDirectThread } from "@/lib/control-plane";
import { broadcastMcpEvent } from "@/lib/pubsub";
import type { AgentControlAction } from "@/lib/agent-control-command";

// Durable control messages use the existing inbox, but are never LLM prompts.
// Lock the agent row to serialize simultaneous operator commands.
export async function requestAgentControl(companyId: string, userId: string, agentId: string, action: AgentControlAction, prompt: string) {
    const [agent] = await db.select({ id: agents.id, provider: agents.provider }).from(agents).where(and(
        eq(agents.companyId, companyId), eq(agents.id, agentId), isNull(agents.deletedAt),
    )).limit(1);
    if (!agent) throw new Error("Agent not found");
    if (agent.provider !== "hermes") throw new Error("Runtime controls require a Hermes agent");
    const thread = await ensureDirectThread(companyId, agentId, userId);
    const messages = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM agents WHERE id = ${agentId}::uuid AND company_id = ${companyId}::uuid FOR NO KEY UPDATE`);
        const changed = [];
        if (action !== "queue") {
            const cancelled = await tx.update(threadMessages).set({ deliveryState: "cancelled" }).where(and(
                eq(threadMessages.companyId, companyId),
                inArray(threadMessages.deliveryState, ["queued", "seen", "acting"]),
                // Direct requests plus a team request this agent is actually handling.
                sql`(${threadMessages.targetAgentId} = ${agentId}::uuid OR (${threadMessages.senderType} = 'human' AND ${threadMessages.metadataJson}->>'executionActorId' = ${agentId}))`,
                eq(threadMessages.senderType, "human"),
            )).returning();
            changed.push(...cancelled);
            const [command] = await tx.insert(threadMessages).values({
                companyId, threadId: thread.id, targetAgentId: agentId, senderType: "system", senderId: userId,
                text: action === "kill" ? "Stop requested; clear pending prompts." : "Replace requested; stop previous work and start the new prompt.",
                deliveryState: "queued", metadataJson: { runtimeControl: { action } },
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
    return { thread, message: messages.at(-1), action, status: action === "queue" ? "queued" : "requested" };
}
