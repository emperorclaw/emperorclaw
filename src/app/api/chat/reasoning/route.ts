import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { messageThreads, threadMessages } from "@/db/schema";
import { canUseDirectThread, getThreadMessageReasoning } from "@/lib/control-plane";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMayUseAllAgents } from "@/lib/agent-access-server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/chat/reasoning?messageId=... — the reasoning transcript for one
 * message, scoped to the signed-in user's company.
 *
 * Intentionally one message per request. The chat message list is a polling
 * loop, so reasoning must never ride along with it: the disclosure in the UI is
 * collapsed by default and calls this only when a reader expands it.
 */
export async function GET(req: NextRequest) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const userId = access.ctx.userId;

    const messageId = new URL(req.url).searchParams.get("messageId");
    if (!messageId) return NextResponse.json({ error: "messageId is required" }, { status: 400 });
    if (!UUID_RE.test(messageId)) return NextResponse.json({ error: "messageId must be a UUID" }, { status: 400 });

    try {
        // Someone else's private direct thread: answer as if there were no reasoning,
        // so the endpoint does not confirm the message exists.
        const [thread] = await db.select({ type: messageThreads.type, ownerUserId: messageThreads.ownerUserId, isPrivate: messageThreads.isPrivate, directAgentId: messageThreads.directAgentId, senderType: threadMessages.senderType, senderId: threadMessages.senderId })
            .from(threadMessages)
            .innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
            .where(and(eq(threadMessages.id, messageId), eq(threadMessages.companyId, companyId)))
            .limit(1);
        if (thread && !canUseDirectThread(thread, userId)) return NextResponse.json({ messageId, reasoning: null });
        // Nor the reasoning of (or in the DM of) an agent this person may not use (0.20).
        const agentIds = thread ? [thread.directAgentId, thread.senderType === "agent" ? thread.senderId : null].filter((id): id is string => Boolean(id)) : [];
        if (agentIds.length && !(await memberMayUseAllAgents(access.ctx, agentIds))) return NextResponse.json({ messageId, reasoning: null });

        const row = await getThreadMessageReasoning(companyId, messageId);
        if (!row) return NextResponse.json({ messageId, reasoning: null });
        return NextResponse.json({
            messageId: row.messageId,
            reasoning: row.reasoning,
            createdAt: row.createdAt,
        });
    } catch (error: unknown) {
        console.error("[/api/chat/reasoning] GET error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
