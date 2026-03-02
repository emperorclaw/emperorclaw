export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, playbooks, schedules } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET() {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user || !(session.user as any).id) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const [membership] = await db.select().from(companyMembers)
            .where(eq(companyMembers.userId, (session.user as any).id))
            .limit(1);

        if (!membership) {
            return NextResponse.json({ error: "Company not found" }, { status: 404 });
        }

        const companyId = membership.companyId;

        const playbookList = await db.select().from(playbooks)
            .where(eq(playbooks.companyId, companyId))
            .orderBy(desc(playbooks.createdAt));

        const scheduleList = await db.select().from(schedules)
            .where(eq(schedules.companyId, companyId))
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
