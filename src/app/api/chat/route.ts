import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { threadParticipants } from "@/db/schema";
import { getCompanyId, getUserId } from "@/lib/auth";
import { and, eq } from "drizzle-orm";
import { appendThreadMessage, ensureDirectThread, ensureTeamThread, getThreadMessages } from "@/lib/control-plane";
import { resolveAgentId } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";

type ThreadMessageLike = {
    fromUserId?: string | null;
    senderId?: string | null;
    [key: string]: unknown;
};

function serializeMessage(message: ThreadMessageLike) {
    return {
        ...message,
        fromUserId: message.fromUserId || message.senderId || null,
    };
}

export async function GET(req: NextRequest) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(req.url);
        const since = searchParams.get("since");
        const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);
        const targetAgentId = searchParams.get("targetAgentId");
        const sinceDate = since ? new Date(since) : null;

        const thread = targetAgentId
            ? await ensureDirectThread(companyId, targetAgentId, await getUserId())
            : await ensureTeamThread(companyId);

        const messages = await getThreadMessages(
            companyId,
            thread.id,
            limit,
            sinceDate && !isNaN(sinceDate.getTime()) ? sinceDate : null
        );

        const participants = await db.select().from(threadParticipants).where(
            and(eq(threadParticipants.companyId, companyId), eq(threadParticipants.threadId, thread.id))
        );

        return NextResponse.json({ thread, messages: messages.map(serializeMessage), participants });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") ? 404 : 500;
        console.error("[/api/chat] GET error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status });
    }
}

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { text, targetAgentId } = await req.json();
        if (!text) return NextResponse.json({ error: "Text is required" }, { status: 400 });

        const resolvedTargetAgentId = targetAgentId
            ? await resolveAgentId(companyId, targetAgentId)
            : null;
        const thread = resolvedTargetAgentId
            ? await ensureDirectThread(companyId, resolvedTargetAgentId, userId)
            : await ensureTeamThread(companyId);
        const message = await appendThreadMessage({
            companyId,
            threadId: thread.id,
            senderType: "human",
            senderId: userId,
            targetAgentId: resolvedTargetAgentId,
            text,
            mirrorToLegacyChat: !resolvedTargetAgentId,
        });

        broadcastMcpEvent(companyId, {
            type: "thread_message",
            thread,
            message,
        });

        return NextResponse.json({ thread, message: serializeMessage(message) });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") ? 404 : 500;
        console.error("[/api/chat] POST error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status });
    }
}
