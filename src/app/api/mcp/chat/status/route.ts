import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { threadParticipants } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;

    try {
        const body = await req.json();
        const { threadId, typing, markRead, agentId } = body;
        
        if (!threadId) return NextResponse.json({ error: "threadId is required" }, { status: 400 });
        if (!agentId) return NextResponse.json({ error: "agentId is required for status updates" }, { status: 400 });

        const resolvedAgentId = await resolveAgentId(companyId, agentId);

        const updates: any = {};
        if (markRead) updates.lastReadAt = new Date();
        if (typeof typing === 'boolean') {
            updates.typingUntil = typing ? new Date(Date.now() + 5000) : null;
        }

        if (Object.keys(updates).length > 0) {
            await db.update(threadParticipants)
                .set(updates)
                .where(and(
                    eq(threadParticipants.companyId, companyId),
                    eq(threadParticipants.threadId, threadId),
                    eq(threadParticipants.participantType, "agent"),
                    eq(threadParticipants.participantId, resolvedAgentId)
                ));
            
            // Broadcast for UI reactivity
            broadcastMcpEvent(companyId, {
                type: "participant_status",
                threadId,
                participantId: resolvedAgentId,
                typing: !!typing,
                lastReadAt: updates.lastReadAt,
            });
        }

        return NextResponse.json({ ok: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
