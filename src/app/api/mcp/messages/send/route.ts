import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyMcpToken, resolveBoundAgentId } from "@/lib/mcp";
import { sendThreadMessageFromMcp } from "@/lib/openclaw/messaging";
import { mcpTokenMayUseMessageId, mcpTokenMayUseThreadId } from "@/lib/thread-access";
import { applyStoredObjectiveStatus } from "@/lib/objective-status";
import { parseJsonBody, optionalString } from "@/lib/validation";
import crypto from "crypto";
import { db } from "@/db";
import { threadMessages, threadParticipants } from "@/db/schema";
import { and, eq, gt, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";

const sendMessageSchema = z.object({
    text: z.string().min(1, "text is required"),
    replyToMessageId: z.string().uuid().nullish(),
    chat_id: optionalString,
    thread_id: optionalString,
    from_user_id: optionalString,
    agentId: optionalString,
    targetAgentId: optionalString,
    target_agent_id: optionalString,
    thread_type: optionalString,
    // Backward compatible opt-out of team-first peer messaging.
    private: z.boolean().optional(),
    // An "acknowledge first" post: it does not answer its replyToMessageId, so
    // the sync's answered cutoff ignores it (see answeredCutoffByThread).
    ack: z.boolean().optional(),
    // Coalesced replies (capability "coalesced-replies: 1"): queued messages of
    // the same thread this reply also answers. Resolved together with the reply.
    alsoResolvesMessageIds: z.array(z.string().uuid()).max(20).optional(),
}).loose();

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Mark the messages a coalesced reply also answers as resolved, scoped to the
 * reply's thread and to work this agent was handed: human/system messages
 * addressed to it or untargeted, not newer than the message it answers, and
 * not already resolved or cancelled. An agent can never resolve a message
 * targeted at another agent. Runs in the reply transaction.
 */
async function resolveCoalesced(
    tx: DbTx,
    input: {
        companyId: string; threadId: string; agentId: string; replyMessageId: string;
        replyToMessageId: string; sourceCreatedAt: Date; ids: string[];
    },
) {
    const ids = [...new Set(input.ids)];
    if (ids.length === 0) return [];
    return tx.update(threadMessages).set({
        deliveryState: "resolved",
        metadataJson: sql`coalesce(${threadMessages.metadataJson}, '{}'::jsonb) || ${JSON.stringify({
            executionStateUpdatedAt: new Date().toISOString(),
            executionStateUpdatedBy: "agent",
            executionActorId: input.agentId,
            resolvedByMessageId: input.replyMessageId,
            coalescedIntoMessageId: input.replyToMessageId,
        })}::jsonb`,
    }).where(and(
        eq(threadMessages.companyId, input.companyId),
        eq(threadMessages.threadId, input.threadId),
        inArray(threadMessages.id, ids),
        inArray(threadMessages.senderType, ["human", "system"]),
        notInArray(threadMessages.deliveryState, ["resolved", "cancelled"]),
        or(isNull(threadMessages.targetAgentId), eq(threadMessages.targetAgentId, input.agentId)),
        // Strictly older: createdAt has millisecond precision, so a message in the
        // same millisecond as the source may be newer. Leaving it open costs one
        // more look from the agent; resolving it would drop it unanswered.
        lt(threadMessages.createdAt, input.sourceCreatedAt),
    )).returning();
}

// A retried reply (bridge outbox) reuses its Idempotency-Key; a stored message
// with the same key from the same agent in the same thread is returned instead
// of inserting a second copy. Bounded to a recent window so the lookup stays a
// narrow scan of one thread.
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

function idempotencyKeyFrom(req: NextRequest): string | null {
    const key = req.headers.get("idempotency-key")?.trim() || "";
    return IDEMPOTENCY_KEY_RE.test(key) ? key : null;
}

// Dedup cache: hash(agentId + threadId + text) → timestamp
// Prevents the EXACT same message from being posted twice within 120 seconds.
const dedupCache = new Map<string, number>();
const DEDUP_WINDOW_MS = 120_000; // 2 minutes

function dedupKey(agentId: string, threadId: string, text: string): string {
    return crypto.createHash("sha256")
        .update(`${agentId}:${threadId}:${text.trim()}`)
        .digest("hex");
}

function wasRecentlySent(key: string): boolean {
    const lastSent = dedupCache.get(key);
    return Boolean(lastSent && Date.now() - lastSent < DEDUP_WINDOW_MS);
}

// Called only AFTER a successful send: recording before the send would poison
// the key on failure, so the bridge's retry would be treated as a duplicate and
// the message would be silently dropped.
function recordSent(key: string): void {
    const now = Date.now();
    dedupCache.set(key, now);
    // Cleanup old entries periodically
    if (dedupCache.size > 1000) {
        for (const [k, v] of dedupCache) {
            if (now - v > DEDUP_WINDOW_MS) dedupCache.delete(k);
        }
    }
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;

    try {
        const parsed = await parseJsonBody(req, sendMessageSchema);
        if (parsed.error !== undefined) {
            return NextResponse.json({ error: parsed.error }, { status: 400 });
        }
        const { chat_id, text, thread_id, from_user_id, agentId, targetAgentId, target_agent_id, thread_type, replyToMessageId, private: isPrivate, ack, alsoResolvesMessageIds } = parsed.data;
        // Only replies are made idempotent: they are what the bridge retries.
        const idempotencyKey = replyToMessageId ? idempotencyKeyFrom(req) : null;

        // A token bound to an agent may only send as that agent.
        const effectiveAgentId = await resolveBoundAgentId(companyId, auth.companyToken!, agentId || null);

        // A person's private direct thread (named directly or via the message
        // being answered) is only for a request acting as that thread's agent:
        // the bound agent, or the agent a company-wide token sends as.
        if (!(await mcpTokenMayUseThreadId(companyId, effectiveAgentId, thread_id))
            || !(await mcpTokenMayUseMessageId(companyId, effectiveAgentId, replyToMessageId))) {
            return NextResponse.json({ error: "Thread not found" }, { status: 404 });
        }

        // Deduplicate: reject if this agent already sent the exact same
        // text in this thread within the last 2 minutes. This is a real fix —
        // it prevents token-wasting duplicate messages from being stored at all.
        const key = effectiveAgentId && thread_id ? dedupKey(effectiveAgentId, thread_id, text) : null;
        if (key && wasRecentlySent(key)) {
            return NextResponse.json(
                { ok: true, message_id: null, thread_id, deduplicated: true },
            );
        }

        const send = () => sendThreadMessageFromMcp({
            companyId,
            text,
            chatId: chat_id || null,
            threadId: thread_id || null,
            fromUserId: from_user_id || null,
            agentId: effectiveAgentId,
            callerAgentId: auth.companyToken!.agentId ?? null,
            targetAgentId: targetAgentId || target_agent_id || null,
            threadType: thread_type || null,
            replyToMessageId: replyToMessageId || null,
            private: isPrivate === true,
            ack: ack === true,
            idempotencyKey,
        });

        // An acknowledgement answers nothing, so it never resolves coalesced messages.
        const coalescedIds = ack === true ? [] : (alsoResolvesMessageIds ?? []);
        let coalescedResolved: Array<typeof threadMessages.$inferSelect> = [];

        // Serialize a reply with /kill and /replace on the same agent row.
        // This closes the completion race: cancelled work cannot post a late reply.
        const result = replyToMessageId && effectiveAgentId ? await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM agents WHERE id = ${effectiveAgentId}::uuid AND company_id = ${companyId}::uuid FOR NO KEY UPDATE`);
            const [source] = await tx.select().from(threadMessages).where(and(
                eq(threadMessages.id, replyToMessageId), eq(threadMessages.companyId, companyId),
                thread_id ? eq(threadMessages.threadId, thread_id) : undefined,
            )).limit(1);
            if (!source) throw new Error("Thread not found");
            if (idempotencyKey) {
                const [existing] = await tx.select({ id: threadMessages.id, threadId: threadMessages.threadId }).from(threadMessages).where(and(
                    eq(threadMessages.companyId, companyId), eq(threadMessages.threadId, source.threadId),
                    eq(threadMessages.senderType, "agent"), eq(threadMessages.senderId, effectiveAgentId),
                    gt(threadMessages.createdAt, new Date(Date.now() - IDEMPOTENCY_WINDOW_MS)),
                    sql`${threadMessages.metadataJson}->>'idempotencyKey' = ${idempotencyKey}`,
                )).limit(1);
                // Already stored by an earlier attempt whose response was lost.
                if (existing) {
                    // Idempotent: a replay re-applies the (no-op) coalesced resolution.
                    coalescedResolved = await resolveCoalesced(tx, {
                        companyId, threadId: existing.threadId, agentId: effectiveAgentId,
                        replyMessageId: existing.id, replyToMessageId, sourceCreatedAt: source.createdAt, ids: coalescedIds,
                    });
                    return { ok: true, messageId: existing.id, threadId: existing.threadId, replayed: true as const };
                }
            }
            if (source.deliveryState === "cancelled") return null;
            const [stop] = await tx.select({ id: threadMessages.id }).from(threadMessages).where(and(
                eq(threadMessages.companyId, companyId), eq(threadMessages.targetAgentId, effectiveAgentId),
                eq(threadMessages.senderType, "system"), eq(threadMessages.deliveryState, "queued"),
                sql`${threadMessages.metadataJson}->'runtimeControl'->>'action' IN ('kill', 'replace')`,
            )).limit(1);
            if (stop) return null;
            const sent = await send();
            if (sent.ok && sent.messageId && sent.threadId) {
                coalescedResolved = await resolveCoalesced(tx, {
                    companyId, threadId: sent.threadId, agentId: effectiveAgentId,
                    replyMessageId: sent.messageId, replyToMessageId, sourceCreatedAt: source.createdAt, ids: coalescedIds,
                });
            }
            return sent;
        }) : await send();
        if (!result) return NextResponse.json({ ok: true, message_id: null, thread_id, cancelled: true });

        // Tool-less runtime fallback: a normal agent reply may carry an
        // objective-status marker. Apply it after the send transaction so this
        // never deadlocks the agent row lock, and never fail the send over it.
        if (result.messageId && !("replayed" in result)) {
            await applyStoredObjectiveStatus(companyId, result.messageId)
                .catch((error) => console.error("Objective status marker failed:", error));
        }

        // The answer is in: stop showing the agent as working in this thread.
        // The runtime also sends typing=false, but if that call is lost the
        // indicator would linger for the whole typing TTL. An acknowledgement
        // is not the answer — the agent is still working after it.
        if (result.ok && replyToMessageId && effectiveAgentId && ack !== true && result.threadId) {
            await db.update(threadParticipants)
                .set({ typingUntil: null, currentActivity: null })
                .where(and(
                    eq(threadParticipants.companyId, companyId),
                    eq(threadParticipants.threadId, result.threadId),
                    eq(threadParticipants.participantType, "agent"),
                    eq(threadParticipants.participantId, effectiveAgentId),
                ))
                .catch((error) => console.error("Clearing typing after reply failed:", error));
        }

        for (const message of coalescedResolved) {
            await broadcastMcpEvent(companyId, { type: "thread_message", threadId: message.threadId, message });
        }

        // Record only after the send succeeded so a failed send does not poison
        // the key and make the bridge's retry look like a duplicate.
        if (key && result.ok) recordSent(key);

        return NextResponse.json({
            ok: result.ok,
            message_id: result.messageId,
            thread_id: result.threadId,
            ...("replayed" in result ? { replayed: true } : {}),
            ...(coalescedIds.length > 0 ? { resolvedMessageIds: coalescedResolved.map((message) => message.id) } : {}),
        });
    } catch (error) {
        console.error("Chat send webhook error:", error);
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") || message === "Thread not found"
            ? 404
            : message.startsWith("Access denied") || message.startsWith("You can't reach")
                ? 403
                : message.startsWith("Loop guard")
                    ? 429
                    : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
