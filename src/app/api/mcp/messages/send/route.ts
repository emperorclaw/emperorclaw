import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { appendThreadMessage, ensureDirectThread, ensureTeamThread } from "@/lib/control-plane";
import { resolveAgentId } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;

    try {
        const body = await req.json();
        // Adhering to OpenClaw Custom Channel Adapter Spec v1
        const { chat_id, text, thread_id, from_user_id, agentId, targetAgentId, thread_type } = body;

        if (!chat_id || !text) {
            return NextResponse.json({ error: "chat_id and text required" }, { status: 400 });
        }

        const senderId = from_user_id || agentId || 'openclaw';
        const resolvedSenderId = await resolveAgentId(companyId, senderId);
        const resolvedTargetAgentId = targetAgentId ? await resolveAgentId(companyId, targetAgentId) : null;
        const thread = resolvedTargetAgentId || thread_type === "direct"
            ? await ensureDirectThread(companyId, resolvedTargetAgentId || resolvedSenderId)
            : await ensureTeamThread(companyId);
        const message = await appendThreadMessage({
            companyId,
            threadId: thread_id || thread.id,
            senderType: 'agent',
            senderId: resolvedSenderId,
            targetAgentId: resolvedTargetAgentId,
            text,
            metadataJson: { chatId: chat_id },
            mirrorToLegacyChat: !resolvedTargetAgentId,
        });

        broadcastMcpEvent(companyId, { type: 'thread_message', thread, message });

        return NextResponse.json({
            ok: true,
            message_id: message.id,
            thread_id: thread.id,
        });
    } catch (error) {
        console.error("Chat send webhook error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
