import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { appendThreadMessage, ensureDirectThread, ensureTeamThread } from "@/lib/control-plane";
import { resolveAgentId } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { db } from "@/db";
import { messageThreads } from "@/db/schema";
import { and, eq } from "drizzle-orm";

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

        if (!text || (!chat_id && !thread_id)) {
            return NextResponse.json({ error: "text and either chat_id or thread_id are required" }, { status: 400 });
        }

        const senderId = from_user_id || agentId || 'openclaw';
        const resolvedSenderId = await resolveAgentId(companyId, senderId);
        const resolvedTargetAgentId = targetAgentId ? await resolveAgentId(companyId, targetAgentId) : null;
        const thread = resolvedTargetAgentId || thread_type === "direct"
            ? await ensureDirectThread(companyId, resolvedTargetAgentId || resolvedSenderId)
            : await ensureTeamThread(companyId);

        const isUuid = (val: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
        let targetThreadId = thread.id;
        let responseThread = thread;
        if (thread_id && isUuid(thread_id)) {
            const [existingThread] = await db.select().from(messageThreads).where(
                and(eq(messageThreads.id, thread_id), eq(messageThreads.companyId, companyId))
            ).limit(1);

            if (!existingThread) {
                return NextResponse.json({ error: "Thread not found" }, { status: 404 });
            }
            targetThreadId = existingThread.id;
            responseThread = existingThread;
        }

        const message = await appendThreadMessage({
            companyId,
            threadId: targetThreadId,
            senderType: 'agent',
            senderId: resolvedSenderId,
            targetAgentId: resolvedTargetAgentId,
            text,
            metadataJson: {
                chatId: chat_id || null,
                threadType: thread_type || null,
            },
            mirrorToLegacyChat: !resolvedTargetAgentId,
        });

        broadcastMcpEvent(companyId, { type: 'thread_message', thread: responseThread, message });

        return NextResponse.json({
            ok: true,
            message_id: message.id,
            thread_id: targetThreadId,
        });
    } catch (error) {
        console.error("Chat send webhook error:", error);
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") ? 404 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
