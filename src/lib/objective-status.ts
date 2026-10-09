import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { threadMessages } from "@/db/schema";
import { updateObjectiveFromAgent } from "@/lib/agent-objective";
import { readStoredObjectiveMarker } from "@/lib/objective-status-marker";

/**
 * Apply an authorized objective-status marker that appendThreadMessage stashed
 * in the reply's server-reserved metadata. This runs AFTER the message is
 * persisted (outside any send transaction) so it reuses
 * updateObjectiveFromAgent's agent row lock without deadlocking the send path.
 *
 * The text is already sanitized by then, so this never touches visible text and
 * can never fail the reply. A forged/untrusted marker never reaches here: the
 * metadata key is stripped from caller input and only set by the server after
 * the source/agent/thread/objective checks pass.
 */
export async function applyStoredObjectiveStatus(companyId: string, messageId: string): Promise<boolean> {
    const [message] = await db.select({
        id: threadMessages.id,
        senderType: threadMessages.senderType,
        senderId: threadMessages.senderId,
        metadataJson: threadMessages.metadataJson,
    }).from(threadMessages).where(and(
        eq(threadMessages.id, messageId),
        eq(threadMessages.companyId, companyId),
    )).limit(1);
    if (!message || message.senderType !== "agent" || !message.senderId) return false;

    const marker = readStoredObjectiveMarker(message.metadataJson);
    if (!marker) return false;

    try {
        await updateObjectiveFromAgent(companyId, message.senderId, {
            objectiveId: marker.objectiveId,
            action: marker.action,
            summary: marker.summary ?? null,
            blockerReason: marker.blockerReason ?? null,
            completionSummary: marker.completionSummary ?? null,
            objective: marker.objective ?? null,
            cadenceMinutes: marker.cadenceMinutes ?? null,
        });
    } catch {
        // An invalid transition (e.g. already closed) is dropped silently.
    }
    return true;
}
