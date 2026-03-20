import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { messageThreads } from "@/db/schema";
import { getCompanyId, getUserId } from "@/lib/auth";
import { and, eq } from "drizzle-orm";
import { appendThreadMessage, ensureDirectThread, ensureTeamThread, getThreadMessages } from "@/lib/control-plane";
import { resolveAgentId } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";

function serializeMessage(message: any) {
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

        return NextResponse.json({ thread, messages: messages.map(serializeMessage) });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
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
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
