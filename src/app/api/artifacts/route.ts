export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, artifacts, projects, tasks, customers } from "@/db/schema";
import { eq, desc, and, isNull } from "drizzle-orm";

export async function GET() {
    try {
        const session = await getServerSession(authOptions);
        const user = session?.user as { id?: string } | undefined;
        if (!user?.id) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const [membership] = await db.select().from(companyMembers)
            .where(eq(companyMembers.userId, user.id))
            .limit(1);

        if (!membership) {
            return NextResponse.json({ error: "Company not found" }, { status: 404 });
        }

        const companyId = membership.companyId;

        const results = await db.select({
            id: artifacts.id,
            title: artifacts.title,
            kind: artifacts.kind,
            artifactClass: artifacts.artifactClass,
            importance: artifacts.importance,
            contentType: artifacts.contentType,
            contentText: artifacts.contentText,
            storageUrl: artifacts.storageUrl,
            originalFilename: artifacts.originalFilename,
            sizeBytes: artifacts.sizeBytes,
            isCanonical: artifacts.isCanonical,
            createdAt: artifacts.createdAt,
            projectId: projects.id,
            projectGoal: projects.goal,
            customerId: customers.id,
            customerName: customers.name,
            taskType: tasks.taskType,
        }).from(artifacts)
            .leftJoin(projects, eq(artifacts.projectId, projects.id))
            .leftJoin(customers, eq(projects.customerId, customers.id))
            .leftJoin(tasks, eq(artifacts.taskId, tasks.id))
            .where(and(eq(artifacts.companyId, companyId), isNull(artifacts.deletedAt)))
            .orderBy(desc(artifacts.createdAt));

        return NextResponse.json({ artifacts: results });
    } catch (error: unknown) {
        console.error("Error fetching artifacts:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
