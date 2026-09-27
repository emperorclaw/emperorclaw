import { db } from "@/db";
import { threadMessages } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";

// A direct-chat sender owns the prompts they placed in that chat.  Keeping the
// transition here (rather than in the UI) makes cancellation durable and lets
// the bridge observe it on its next control poll.
export async function updateDirectMessageQueueItem(input: {
    companyId: string;
    userId: string;
    messageId: string;
    action: "cancel" | "retry";
}) {
    const fromStates = input.action === "cancel"
        ? ["queued", "seen", "acting"]
        : ["cancelled"];
    const toState = input.action === "cancel" ? "cancelled" : "queued";

    const [message] = await db.update(threadMessages).set({ deliveryState: toState }).where(and(
        eq(threadMessages.id, input.messageId),
        eq(threadMessages.companyId, input.companyId),
        eq(threadMessages.senderType, "human"),
        eq(threadMessages.senderId, input.userId),
        inArray(threadMessages.deliveryState, fromStates),
    )).returning();

    if (!message) throw new Error(
        input.action === "cancel"
            ? "This message is no longer waiting or being handled"
            : "Only a cancelled message can be retried",
    );

    broadcastMcpEvent(input.companyId, { type: "thread_message", threadId: message.threadId, message });
    return message;
}
