import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyMcpToken, resolveBoundAgentId } from "@/lib/mcp";
import { sendThreadMessageFromMcp } from "@/lib/openclaw/messaging";
import { applyStoredObjectiveStatus } from "@/lib/objective-status";
import { parseJsonBody, optionalString } from "@/lib/validation";
import crypto from "crypto";
import { db } from "@/db";
import { threadMessages, threadParticipants } from "@/db/schema";
import { and, eq, gt, sql } from "drizzle-orm";

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
}).loose();

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
        const { chat_id, text, thread_id, from_user_id, agentId, targetAgentId, target_agent_id, thread_type, replyToMessageId, private: isPrivate, ack } = parsed.data;
        // Only replies are made idempotent: they are what the bridge retries.
        const idempotencyKey = replyToMessageId ? idempotencyKeyFrom(req) : null;

        // A token bound to an agent may only send as that agent.
        const effectiveAgentId = await resolveBoundAgentId(companyId, auth.companyToken!, agentId || null);

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
            targetAgentId: targetAgentId || target_agent_id || null,
            threadType: thread_type || null,
            replyToMessageId: replyToMessageId || null,
            private: isPrivate === true,
            ack: ack === true,
            idempotencyKey,
        });

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
                if (existing) return { ok: true, messageId: existing.id, threadId: existing.threadId, replayed: true as const };
            }
            if (source.deliveryState === "cancelled") return null;
            const [stop] = await tx.select({ id: threadMessages.id }).from(threadMessages).where(and(
                eq(threadMessages.companyId, companyId), eq(threadMessages.targetAgentId, effectiveAgentId),
                eq(threadMessages.senderType, "system"), eq(threadMessages.deliveryState, "queued"),
                sql`${threadMessages.metadataJson}->'runtimeControl'->>'action' IN ('kill', 'replace')`,
            )).limit(1);
            if (stop) return null;
            return send();
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

        // Record only after the send succeeded so a failed send does not poison
        // the key and make the bridge's retry look like a duplicate.
        if (key && result.ok) recordSent(key);

        return NextResponse.json({
            ok: result.ok,
            message_id: result.messageId,
            thread_id: result.threadId,
            ...("replayed" in result ? { replayed: true } : {}),
        });
    } catch (error) {
        console.error("Chat send webhook error:", error);
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") || message === "Thread not found"
            ? 404
            : message.startsWith("Access denied")
                ? 403
                : message.startsWith("Loop guard")
                    ? 429
                    : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
