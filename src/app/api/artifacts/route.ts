export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { memberRecordCondition } from "@/lib/member-scope";
import { db } from "@/db";
import { artifacts, projects, tasks, customers } from "@/db/schema";
import { eq, desc, and, isNull } from "drizzle-orm";

export async function GET() {
    try {
        const access = await companyRouteAccess("viewer");
        if (access.response) return access.response;
        const companyId = access.ctx.companyId;

        const results = await db.select({
            id: artifacts.id,
            title: artifacts.title,
            kind: artifacts.kind,
            artifactClass: artifacts.artifactClass,
            importance: artifacts.importance,
            contentType: artifacts.contentType,
            contentText: artifacts.contentText,
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
            .where(and(eq(artifacts.companyId, companyId), isNull(artifacts.deletedAt),
                memberRecordCondition(access.ctx.scope, { projectId: artifacts.projectId, customerId: artifacts.customerId, projectCustomerId: projects.customerId })))
            .orderBy(desc(artifacts.createdAt));

        return NextResponse.json({ artifacts: results });
    } catch (error: unknown) {
        console.error("Error fetching artifacts:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
