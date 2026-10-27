import { db } from "@/db";
import { agents, messageThreads, threadMessages } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";

/**
 * States a sender may retry from. A message the sender stopped and a message
 * the runtime gave up on (markMessageFailedByRuntime) both end "cancelled";
 * the failed one also carries metadataJson.runtimeFailure, which is what the
 * inbox shows as "Message failed". There is no separate "failed" state.
 */
const RETRYABLE_STATES = ["cancelled"];
const CANCELLABLE_STATES = ["queued", "seen", "acting"];

/** Metadata a retry clears so the message reads (and is counted) as fresh. */
const FAILURE_METADATA_KEYS = ["runtimeFailure", "failedAttempts", "lastFailedAt"] as const;

// A direct-chat sender owns the prompts they placed in that chat.  Keeping the
// transition here (rather than in the UI) makes cancellation durable and lets
// the bridge observe it on its next control poll.
export async function updateDirectMessageQueueItem(input: {
    companyId: string;
    userId: string;
    messageId: string;
    action: "cancel" | "retry";
}) {
    const ownMessage = and(
        eq(threadMessages.id, input.messageId),
        eq(threadMessages.companyId, input.companyId),
        eq(threadMessages.senderType, "human"),
        eq(threadMessages.senderId, input.userId),
    );

    if (input.action === "cancel") {
        const [message] = await db.update(threadMessages).set({ deliveryState: "cancelled" })
            .where(and(ownMessage, inArray(threadMessages.deliveryState, CANCELLABLE_STATES)))
            .returning();
        if (!message) throw new Error("This message is no longer waiting or being handled");
        broadcastMcpEvent(input.companyId, { type: "thread_message", threadId: message.threadId, message });
        return message;
    }

    const [current] = await db.select().from(threadMessages)
        .where(and(ownMessage, inArray(threadMessages.deliveryState, RETRYABLE_STATES)))
        .limit(1);
    if (!current) throw new Error("Only a stopped or failed message can be retried");

    // A runtime only re-reads an old message when it is still open AND
    // targeted at it (the sync returns those whatever its cursor). A failed
    // @mention in a shared room has no target, so the retry addresses it to
    // the agent that failed it; otherwise the agent would never see it again.
    const failure = ((current.metadataJson as Record<string, unknown> | null)?.runtimeFailure ?? null) as { agentId?: unknown } | null;
    let targetAgentId = current.targetAgentId;
    if (!targetAgentId && typeof failure?.agentId === "string") {
        const [agent] = await db.select({ id: agents.id }).from(agents)
            .where(and(eq(agents.companyId, input.companyId), sql`${agents.id}::text = ${failure.agentId}`))
            .limit(1);
        targetAgentId = agent?.id ?? null;
    }

    const clearedMetadata = FAILURE_METADATA_KEYS.reduce(
        (expr, key) => sql`${expr} - ${key}::text`,
        sql`coalesce(${threadMessages.metadataJson}, '{}'::jsonb)`,
    );
    const [message] = await db.update(threadMessages).set({
        deliveryState: "queued",
        targetAgentId,
        metadataJson: clearedMetadata,
    }).where(and(ownMessage, inArray(threadMessages.deliveryState, RETRYABLE_STATES))).returning();
    if (!message) throw new Error("Only a stopped or failed message can be retried");

    // The same event a newly sent message produces (POST /api/chat), so the
    // agent's runtime and every open chat pick the retry up at once.
    const [thread] = await db.select().from(messageThreads)
        .where(and(eq(messageThreads.id, message.threadId), eq(messageThreads.companyId, input.companyId)))
        .limit(1);
    broadcastMcpEvent(input.companyId, { type: "thread_message", thread: thread ?? undefined, threadId: message.threadId, message });
    return message;
}
