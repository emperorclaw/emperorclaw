import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { threadParticipants } from "@/db/schema";
import { getCompanyId, getUserId } from "@/lib/auth";
import { and, eq, sql } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { threadId, typing, markRead } = await req.json();
        if (!threadId) return NextResponse.json({ error: "threadId is required" }, { status: 400 });

        const updates: any = {};
        if (markRead) updates.lastReadAt = new Date();
        if (typeof typing === 'boolean') {
            // Typing for 5 seconds by default
            updates.typingUntil = typing ? new Date(Date.now() + 5000) : null;
        }

        if (Object.keys(updates).length > 0) {
            await db.update(threadParticipants)
                .set(updates)
                .where(and(
                    eq(threadParticipants.companyId, companyId),
                    eq(threadParticipants.threadId, threadId),
                    eq(threadParticipants.participantType, "human"),
                    eq(threadParticipants.participantRef, userId)
                ));
            
            // Broadcast so the agent sees the human's status (optional, but good)
            broadcastMcpEvent(companyId, {
                type: "participant_status",
                threadId,
                participantId: userId,
                typing: !!typing,
                lastReadAt: updates.lastReadAt,
            });
        }

        return NextResponse.json({ ok: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
