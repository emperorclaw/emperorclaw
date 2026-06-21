import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { messageThreads } from "@/db/schema";
import { appendThreadMessage, getThreadMessages } from "@/lib/control-plane";
import { broadcastMcpEvent } from "@/lib/pubsub";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: threadId } = await params;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
    const sinceParam = searchParams.get("since");
    const beforeParam = searchParams.get("before");
    const since = sinceParam ? new Date(sinceParam) : null;
    const before = beforeParam ? new Date(beforeParam) : null;

    const [thread] = await db.select().from(messageThreads).where(
        and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId))
    ).limit(1);

    if (!thread) {
        return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    const messages = await getThreadMessages(
        companyId,
        threadId,
        limit + 1,
        since && !isNaN(since.getTime()) ? since : null,
        before && !isNaN(before.getTime()) ? before : null
    );
    const hasMore = !since && messages.length > limit;
    return NextResponse.json({ thread, messages: hasMore ? messages.slice(1) : messages, hasMore });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: threadId } = await params;

    try {
        const [thread] = await db.select().from(messageThreads).where(
            and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId))
        ).limit(1);

        if (!thread) {
            return NextResponse.json({ error: "Thread not found" }, { status: 404 });
        }

        const body = await req.json();
        const { text, senderType = "agent", senderId, targetAgentId, metadataJson, mirrorToLegacyChat = false } = body;

        if (!text) {
            return NextResponse.json({ error: "text is required" }, { status: 400 });
        }

        const resolvedSenderId = senderType === "agent" && senderId
            ? await resolveAgentId(companyId, senderId)
            : senderId || null;
        const resolvedTargetAgentId = targetAgentId
            ? await resolveAgentId(companyId, targetAgentId)
            : null;
        const shouldMirrorToLegacyChat = mirrorToLegacyChat || thread.type === "team";

        const message = await appendThreadMessage({
            companyId,
            threadId,
            senderType,
            senderId: resolvedSenderId,
            targetAgentId: resolvedTargetAgentId,
            text,
            metadataJson: metadataJson || {},
            mirrorToLegacyChat: shouldMirrorToLegacyChat,
        });

        await broadcastMcpEvent(companyId, { type: "thread_message", thread, message });

        return NextResponse.json({ message }, { status: 201 });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") ? 404 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
