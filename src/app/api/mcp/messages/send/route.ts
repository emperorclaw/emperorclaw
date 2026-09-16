import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyMcpToken, resolveBoundAgentId } from "@/lib/mcp";
import { sendThreadMessageFromMcp } from "@/lib/openclaw/messaging";
import { parseJsonBody, optionalString } from "@/lib/validation";
import crypto from "crypto";

const sendMessageSchema = z.object({
    text: z.string().min(1, "text is required"),
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
        const { chat_id, text, thread_id, from_user_id, agentId, targetAgentId, target_agent_id, thread_type } = parsed.data;

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

        const result = await sendThreadMessageFromMcp({
            companyId,
            text,
            chatId: chat_id || null,
            threadId: thread_id || null,
            fromUserId: from_user_id || null,
            agentId: effectiveAgentId,
            targetAgentId: targetAgentId || target_agent_id || null,
            threadType: thread_type || null,
        });

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
