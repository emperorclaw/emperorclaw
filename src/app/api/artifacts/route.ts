export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, artifacts, projects, tasks } from "@/db/schema";
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

        const results = await db.select({
            id: artifacts.id,
            kind: artifacts.kind,
            contentType: artifacts.contentType,
            contentText: artifacts.contentText,
            storageUrl: artifacts.storageUrl,
            sizeBytes: artifacts.sizeBytes,
            createdAt: artifacts.createdAt,
            projectGoal: projects.goal,
            taskType: tasks.taskType,
        }).from(artifacts)
            .leftJoin(projects, eq(artifacts.projectId, projects.id))
            .leftJoin(tasks, eq(artifacts.taskId, tasks.id))
            .where(eq(artifacts.companyId, companyId))
            .orderBy(desc(artifacts.createdAt));

        return NextResponse.json({ artifacts: results });
    } catch (error) {
        console.error("Error fetching artifacts:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
