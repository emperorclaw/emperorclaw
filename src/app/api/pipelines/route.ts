export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, playbooks, schedules } from "@/db/schema";
import { eq, desc, and, isNull } from "drizzle-orm";

export async function GET() {
    try {
        const session = await getValidatedServerSession();
        const sessionUserId = session?.user?.id;
        if (!sessionUserId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const [membership] = await db.select().from(companyMembers)
            .where(eq(companyMembers.userId, sessionUserId))
            .limit(1);

        if (!membership) {
            return NextResponse.json({ error: "Company not found" }, { status: 404 });
        }

        const companyId = membership.companyId;

        const playbookList = await db.select().from(playbooks)
            .where(and(eq(playbooks.companyId, companyId), isNull(playbooks.deletedAt)))
            .orderBy(desc(playbooks.createdAt));

        const scheduleList = await db.select().from(schedules)
            .where(and(eq(schedules.companyId, companyId), isNull(schedules.deletedAt)))
            .orderBy(desc(schedules.createdAt));

        return NextResponse.json({
            playbooks: playbookList,
            schedules: scheduleList
        });
    } catch (error) {
        console.error("Error fetching pipelines data:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
