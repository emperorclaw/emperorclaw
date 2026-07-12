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
