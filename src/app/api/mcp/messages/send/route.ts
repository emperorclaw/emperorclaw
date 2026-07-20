import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyMcpToken } from "@/lib/mcp";
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

function isDuplicate(agentId: string, threadId: string, text: string): boolean {
    const key = crypto.createHash("sha256")
        .update(`${agentId}:${threadId}:${text.trim()}`)
        .digest("hex");
    const now = Date.now();
    const lastSent = dedupCache.get(key);
    if (lastSent && now - lastSent < DEDUP_WINDOW_MS) {
        return true;
    }
    dedupCache.set(key, now);
    // Cleanup old entries periodically
    if (dedupCache.size > 1000) {
        for (const [k, v] of dedupCache) {
            if (now - v > DEDUP_WINDOW_MS) dedupCache.delete(k);
        }
    }
    return false;
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

        // Deduplicate: reject if this agent already sent the exact same
        // text in this thread within the last 2 minutes. This is a real fix —
        // it prevents token-wasting duplicate messages from being stored at all.
        if (agentId && thread_id && isDuplicate(agentId, thread_id, text)) {
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
            agentId: agentId || null,
            targetAgentId: targetAgentId || target_agent_id || null,
            threadType: thread_type || null,
        });

        return NextResponse.json({
            ok: result.ok,
            message_id: result.messageId,
            thread_id: result.threadId,
        });
    } catch (error) {
        console.error("Chat send webhook error:", error);
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") || message === "Thread not found" ? 404 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
