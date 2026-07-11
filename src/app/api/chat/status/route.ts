import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { threadParticipants } from "@/db/schema";
import { getCompanyId, getUserId } from "@/lib/auth";
import { and, eq } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { normalizeExecutionState } from "@/lib/project-workflow";
import { markThreadRead, updateThreadExecutionState } from "@/lib/control-plane";

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { threadId, typing, markRead, executionState } = await req.json();
        if (!threadId) return NextResponse.json({ error: "threadId is required" }, { status: 400 });

        let markedReadAt: Date | undefined;
        if (markRead) {
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
            const updatedMessage = await updateThreadExecutionState({
                companyId,
                threadId,
                actorType: "human",
                actorId: userId,
                targetState: derivedState,
            });

            if (updatedMessage) {
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
