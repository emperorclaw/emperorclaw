import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyMcpToken, resolveBoundAgentId } from "@/lib/mcp";
import { sendThreadMessageFromMcp } from "@/lib/openclaw/messaging";
import { parseJsonBody, optionalString } from "@/lib/validation";
import crypto from "crypto";
import { db } from "@/db";
import { threadMessages } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";

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
}).loose();

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
        const { chat_id, text, thread_id, from_user_id, agentId, targetAgentId, target_agent_id, thread_type, replyToMessageId } = parsed.data;

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

        // Record only after the send succeeded so a failed send does not poison
        // the key and make the bridge's retry look like a duplicate.
        if (key && result.ok) recordSent(key);

        return NextResponse.json({
            ok: result.ok,
            message_id: result.messageId,
            thread_id: result.threadId,
        });
    } catch (error) {
        console.error("Chat send webhook error:", error);
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") || message === "Thread not found"
            ? 404
            : message.startsWith("Access denied")
                ? 403
                : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
