import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyMcpToken } from "@/lib/mcp";
import { sendThreadMessageFromMcp } from "@/lib/openclaw/messaging";
import { parseJsonBody, optionalString } from "@/lib/validation";

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

// In-memory rate limiter: per-agent message timestamps (max 5 per 60s)
const agentRateLimit = new Map<string, number[]>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(agentId: string): boolean {
    const now = Date.now();
    const timestamps = agentRateLimit.get(agentId) || [];
    // Purge old entries
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) return false;
    recent.push(now);
    agentRateLimit.set(agentId, recent);
    return true;
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

        // Rate limit agent messages to prevent loops flooding the server
        if (agentId && !checkRateLimit(agentId)) {
            return NextResponse.json(
                { error: "Rate limit exceeded — max 5 messages per 60 seconds. Bridge safety engaged." },
                { status: 429 },
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
