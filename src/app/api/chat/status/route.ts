import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { messageThreads, threadParticipants } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { normalizeExecutionState } from "@/lib/project-workflow";
import { canUseDirectThread, markThreadRead, updateThreadExecutionState } from "@/lib/control-plane";
import { isAgentPairThread, isCompanyOwnerOrAdmin } from "@/lib/groups";
import { companyRouteAccess } from "@/lib/company-access";
import { canWrite } from "@/lib/role-matrix";

export async function POST(req: NextRequest) {
    // Read receipts and typing are the viewer's own presence (any role);
    // changing a message's execution state is a write (members and up).
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const userId = access.ctx.userId;

    try {
        const { threadId, typing, markRead, executionState } = await req.json();
        if (!threadId) return NextResponse.json({ error: "threadId is required" }, { status: 400 });
        if (executionState !== undefined && executionState !== null && !canWrite(access.ctx.role)) {
            return NextResponse.json({ error: "Forbidden — viewers cannot change message state." }, { status: 403 });
        }

        // Someone else's private direct thread: no read, typing or state changes.
        const [privateThread] = await db.select({ type: messageThreads.type, ownerUserId: messageThreads.ownerUserId, isPrivate: messageThreads.isPrivate })
            .from(messageThreads)
            .where(and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId)))
            .limit(1);
        if (privateThread && !canUseDirectThread(privateThread, userId)) {
            return NextResponse.json({ error: "Access denied: that conversation is private" }, { status: 403 });
        }

        let markedReadAt: Date | undefined;
        if (markRead) {
            // A pair thread is a private two-agent handoff: only owners/admins
            // may open (and thereby mark) it. Everyone else is refused.
            const [thread] = await db.select({ type: messageThreads.type, description: messageThreads.description, createdByType: messageThreads.createdByType })
                .from(messageThreads)
                .where(and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId)))
                .limit(1);
            if (thread && isAgentPairThread(thread) && !(await isCompanyOwnerOrAdmin(companyId, userId))) {
                return NextResponse.json({ error: "Access denied: that pair thread is private" }, { status: 403 });
            }
            // Blind UPDATE can no-op: the shared team thread never gets a
            // human threadParticipants row from ensureTeamThread, so this
            // finds-or-creates it instead.
            markedReadAt = new Date();
            await markThreadRead(companyId, threadId, userId);
        }
        if (typeof typing === 'boolean') {
            // Typing for 5 seconds by default
            await db.update(threadParticipants)
                .set({ typingUntil: typing ? new Date(Date.now() + 5000) : null })
                .where(and(
                    eq(threadParticipants.companyId, companyId),
                    eq(threadParticipants.threadId, threadId),
                    eq(threadParticipants.participantType, "human"),
                    eq(threadParticipants.participantRef, userId)
                ));
        }

        if (markRead || typeof typing === 'boolean') {
            // Broadcast so the agent sees the human's status (optional, but good)
            broadcastMcpEvent(companyId, {
                type: "participant_status",
                threadId,
                participantId: userId,
                typing: !!typing,
                lastReadAt: markedReadAt,
            });
        }

        const derivedState = normalizeExecutionState(executionState)
            || (markRead ? "seen" : null);

        if (derivedState) {
            const updatedMessages = await updateThreadExecutionState({
                companyId,
                threadId,
                actorType: "human",
                actorId: userId,
                targetState: derivedState,
            });

            for (const updatedMessage of updatedMessages) {
                broadcastMcpEvent(companyId, {
                    type: "thread_message",
                    threadId,
                    message: updatedMessage,
                });
            }
        }

        return NextResponse.json({ ok: true });
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
