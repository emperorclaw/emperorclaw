import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, approvalTaskLinks, approvals, messageThreads, tasks, threadMessages } from "@/db/schema";
import { actionLabel } from "./action-policy";
import { broadcastMcpEvent } from "./pubsub";
import { isVerifiedReplyBy } from "./thread-access";
import { APPROVAL_CARD_KEY, approvalCardLabel, approvalCardText } from "./approval-card-copy";

/**
 * Approval cards in chat (0.30, docs/design/approvals-in-chat.md). When an
 * agent asks for approval, one system message (the card) is posted in the
 * thread it asked from, and the decision comes back in that same thread. The
 * approval row stays the single source of truth: the card only points at it
 * (`metadataJson.approvalCard.approvalId`) and the UI reads the live state.
 *
 * The card never wakes an agent (system sender, no target, delivered) and,
 * being a system message, never counts toward the loop-guard streak.
 */

type ApprovalRow = typeof approvals.$inferSelect;
type ThreadRow = typeof messageThreads.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ApprovalThreadError extends Error {
    constructor(message: string, public status: number) {
        super(message);
    }
}

async function loadThread(companyId: string, threadId: string): Promise<ThreadRow | null> {
    if (!UUID_RE.test(threadId)) return null;
    const [thread] = await db.select().from(messageThreads)
        .where(and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId))).limit(1);
    return thread ?? null;
}

/**
 * The card may go where the requester may post (send_message's rules), and a
 * direct thread only when it is the requester's own: the decision is
 * delivered to the requester in the card's thread, and an agent only syncs
 * its own direct threads.
 */
async function assertCardThread(companyId: string, thread: ThreadRow, agentId: string): Promise<void> {
    const { assertAgentMayPostInThread } = await import("./openclaw/messaging");
    await assertAgentMayPostInThread(companyId, thread, agentId);
    if (thread.type === "direct" && thread.directAgentId !== agentId) throw new Error("Thread not found");
}

/**
 * The thread an agent's approval card goes to:
 * 1. an explicit `threadId`, when the requester may post there (else an error:
 *    a wrong thread is the caller's mistake, never silently replaced);
 * 2. the thread of `replyToMessageId`, when the ask is a verified reply by the
 *    requester to a message it was sent (thread-access.ts isVerifiedReplyBy);
 * 3. otherwise the requester's direct thread, where decisions always went.
 * Null when there is no requesting agent (no card).
 */
export async function resolveApprovalThread(input: {
    companyId: string;
    requesterAgentId: string | null | undefined;
    threadId?: unknown;
    replyToMessageId?: unknown;
}): Promise<string | null> {
    const agentId = input.requesterAgentId ?? null;
    if (!agentId) return null;

    if (typeof input.threadId === "string" && input.threadId.trim()) {
        const thread = await loadThread(input.companyId, input.threadId.trim());
        if (!thread) throw new ApprovalThreadError("Thread not found", 404);
        try {
            await assertCardThread(input.companyId, thread, agentId);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Thread not found";
            throw new ApprovalThreadError(message, message.startsWith("Access denied") ? 403 : 404);
        }
        return thread.id;
    }

    if (typeof input.replyToMessageId === "string" && await isVerifiedReplyBy(input.companyId, agentId, null, input.replyToMessageId)) {
        const [source] = await db.select({ threadId: threadMessages.threadId }).from(threadMessages)
            .where(and(eq(threadMessages.id, input.replyToMessageId), eq(threadMessages.companyId, input.companyId))).limit(1);
        const thread = source ? await loadThread(input.companyId, source.threadId) : null;
        if (thread && await assertCardThread(input.companyId, thread, agentId).then(() => true, () => false)) return thread.id;
    }

    const { ensureDirectThread } = await import("./control-plane");
    return (await ensureDirectThread(input.companyId, agentId, null)).id;
}

/** The task title of an approval's first linked task, or null. */
async function firstLinkedTaskTitle(companyId: string, approvalId: string): Promise<string | null> {
    const [row] = await db.select({ taskType: tasks.taskType, inputJson: tasks.inputJson })
        .from(approvalTaskLinks)
        .innerJoin(tasks, eq(tasks.id, approvalTaskLinks.taskId))
        .where(and(eq(approvalTaskLinks.companyId, companyId), eq(approvalTaskLinks.approvalId, approvalId)))
        .orderBy(approvalTaskLinks.createdAt)
        .limit(1);
    if (!row) return null;
    const input = row.inputJson && typeof row.inputJson === "object" ? row.inputJson as Record<string, unknown> : {};
    return typeof input.title === "string" && input.title.trim() ? input.title.trim() : row.taskType;
}

/** The neutral card label for an approval: task title and/or action name, never the rationale. */
export async function approvalCardLabelFor(companyId: string, approval: Pick<ApprovalRow, "id" | "actionType" | "metadataJson">): Promise<string> {
    const meta = approval.metadataJson && typeof approval.metadataJson === "object" ? approval.metadataJson as Record<string, unknown> : {};
    const label = typeof meta.actionLabel === "string" && meta.actionLabel.trim() ? meta.actionLabel : actionLabel(approval.actionType);
    return approvalCardLabel({ actionType: approval.actionType, actionLabel: label, taskTitle: await firstLinkedTaskTitle(companyId, approval.id) });
}

/**
 * Post the approval's card once and link it (`thread_id`, `card_message_id`).
 * Idempotent and safe under concurrency: the approval row is locked and the
 * card is posted only while `card_message_id` is still empty, so a reused
 * pending approval or a concurrent ask never gets a second card. A failure
 * never fails the ask (same contract as notifications): the approval is
 * returned unchanged. Returns the approval as stored afterwards.
 */
export async function postApprovalCard(input: { companyId: string; approval: ApprovalRow; threadId?: string | null }): Promise<ApprovalRow> {
    const { companyId, approval } = input;
    if (!approval.requesterAgentId || approval.cardMessageId || approval.status !== "pending") return approval;
    try {
        const threadId = input.threadId ?? await resolveApprovalThread({ companyId, requesterAgentId: approval.requesterAgentId });
        if (!threadId) return approval;
        const [agent] = await db.select({ name: agents.name }).from(agents)
            .where(and(eq(agents.id, approval.requesterAgentId), eq(agents.companyId, companyId))).limit(1);
        const text = approvalCardText(agent?.name, await approvalCardLabelFor(companyId, approval));

        const posted = await db.transaction(async (tx) => {
            const [current] = await tx.select({ cardMessageId: approvals.cardMessageId, status: approvals.status }).from(approvals)
                .where(and(eq(approvals.id, approval.id), eq(approvals.companyId, companyId)))
                .for("update");
            if (!current || current.cardMessageId || current.status !== "pending") return null;
            const [message] = await tx.insert(threadMessages).values({
                companyId,
                threadId,
                senderType: "system",
                senderId: null,
                // Addressed to nobody and already delivered: a card wakes no agent.
                targetAgentId: null,
                text,
                metadataJson: { [APPROVAL_CARD_KEY]: { approvalId: approval.id } },
                deliveryState: "resolved",
            }).returning();
            const [updated] = await tx.update(approvals).set({ threadId, cardMessageId: message.id })
                .where(and(eq(approvals.id, approval.id), isNull(approvals.cardMessageId))).returning();
            return { message, updated };
        });

        if (!posted) {
            const [fresh] = await db.select().from(approvals).where(eq(approvals.id, approval.id)).limit(1);
            return fresh ?? approval;
        }
        await broadcastMcpEvent(companyId, { type: "thread_message", threadId, message: posted.message });
        return posted.updated ?? approval;
    } catch (error) {
        console.warn("[approvals] could not post the approval card:", error instanceof Error ? error.message : error);
        return approval;
    }
}

/** Record the decision on the card message itself (old clients and mirrors read it), and refresh its thread. */
export async function markApprovalCardDecided(companyId: string, approval: ApprovalRow): Promise<void> {
    if (!approval.cardMessageId) return;
    try {
        const [message] = await db.update(threadMessages).set({
            metadataJson: sql`jsonb_set(${threadMessages.metadataJson}, ${`{${APPROVAL_CARD_KEY},status}`}::text[], to_jsonb(${approval.status}::text), true)`,
        }).where(and(
            eq(threadMessages.id, approval.cardMessageId),
            eq(threadMessages.companyId, companyId),
            eq(threadMessages.senderType, "system"),
            sql`${threadMessages.metadataJson} ? ${APPROVAL_CARD_KEY}`,
        )).returning();
        if (message) await broadcastMcpEvent(companyId, { type: "thread_message", threadId: message.threadId, message });
    } catch (error) {
        console.warn("[approvals] could not update the approval card:", error instanceof Error ? error.message : error);
    }
}

/**
 * Where the decision on an approval is posted: the card's thread while it is
 * still live, else (no card, or the thread was deleted or archived) null, and
 * the caller falls back to the requester's direct thread.
 */
export async function approvalDecisionThread(companyId: string, approval: ApprovalRow): Promise<ThreadRow | null> {
    if (!approval.threadId) return null;
    const thread = await loadThread(companyId, approval.threadId);
    return thread && !thread.archivedAt ? thread : null;
}

