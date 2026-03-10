import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { chatMessages } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;

    try {
        const body = await req.json();
        // Adhering to OpenClaw Custom Channel Adapter Spec v1
        const { chat_id, text, thread_id, reply_to_message_id, attachments, from_user_id, agentId } = body;

        if (!chat_id || !text) {
            return NextResponse.json({ error: "chat_id and text required" }, { status: 400 });
        }

        const senderId = from_user_id || agentId || 'openclaw';

        const [newMessage] = await db.insert(chatMessages).values({
            companyId,
            threadId: thread_id || chat_id,
            senderType: 'agent',
            fromUserId: senderId, // Actual Agent ID
            text,
        }).returning();

        import('@/lib/pubsub').then(({ broadcastMcpEvent }) => {
            broadcastMcpEvent(companyId, { type: 'new_message', message: newMessage });
        });

        return NextResponse.json({
            ok: true,
            message_id: newMessage.id
        });
    } catch (error) {
        console.error("Chat send webhook error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
