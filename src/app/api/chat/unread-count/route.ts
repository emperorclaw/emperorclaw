import { NextResponse } from "next/server";
import { db } from "@/db";
import { messageThreads, threadMessages, threadParticipants } from "@/db/schema";
import { getCompanyId, getUserId } from "@/lib/auth";
import { and, count, eq, gt, isNull, or } from "drizzle-orm";

// Total unread agent messages across every thread (direct + shared team
// thread) the current human is a participant in. Used for the sidebar badge.
export async function GET() {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const [row] = await db
            .select({ value: count() })
            .from(threadMessages)
            .innerJoin(threadParticipants, and(
                eq(threadParticipants.threadId, threadMessages.threadId),
                eq(threadParticipants.companyId, threadMessages.companyId),
                eq(threadParticipants.participantType, "human"),
                eq(threadParticipants.participantRef, userId),
            ))
            .innerJoin(messageThreads, and(
                eq(messageThreads.id, threadMessages.threadId),
                isNull(messageThreads.archivedAt),
            ))
            .where(and(
                eq(threadMessages.companyId, companyId),
                eq(threadMessages.senderType, "agent"),
                or(
                    isNull(threadParticipants.lastReadAt),
                    gt(threadMessages.createdAt, threadParticipants.lastReadAt),
                ),
            ));

        return NextResponse.json({ count: row?.value || 0 });
    } catch (error) {
        console.error("[/api/chat/unread-count] GET error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
