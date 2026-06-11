import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { sendThreadMessageFromMcp } from "@/lib/openclaw/messaging";

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;

    try {
        const body = await req.json();
        const { chat_id, text, thread_id, from_user_id, agentId, targetAgentId, target_agent_id, thread_type } = body;

        if (!text) {
            return NextResponse.json({ error: "text is required" }, { status: 400 });
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
