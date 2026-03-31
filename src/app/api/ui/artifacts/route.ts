import { NextRequest, NextResponse } from "next/server";
import { artifacts, customers, projects, tasks } from "@/db/schema";
import { db } from "@/db";
import { and, desc, eq, gte, ilike, isNull, lte, or, type SQL } from "drizzle-orm";
import { requireCompanyFromSession } from "@/lib/company-session";

export async function GET(req: NextRequest) {
    try {
        const { companyId } = await requireCompanyFromSession();
        const { searchParams } = new URL(req.url);
        const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "100", 10), 1), 500);
        const projectId = searchParams.get("projectId");
        const taskId = searchParams.get("taskId");
        const folderId = searchParams.get("folderId");
        const kind = searchParams.get("kind");
        const artifactClass = searchParams.get("artifactClass");
        const importance = searchParams.get("importance");
        const contentType = searchParams.get("contentType");
        const customerId = searchParams.get("customerId");
        const agentId = searchParams.get("agentId");
        const search = searchParams.get("search");
        const startDateParam = searchParams.get("startDate");
        const endDateParam = searchParams.get("endDate");
        const isCanonical = searchParams.get("isCanonical");

        const conditions: SQL<unknown>[] = [
            eq(artifacts.companyId, companyId),
            isNull(artifacts.deletedAt),
        ];
        if (projectId) conditions.push(eq(artifacts.projectId, projectId));
        if (taskId) conditions.push(eq(artifacts.taskId, taskId));
        if (folderId) conditions.push(eq(artifacts.folderId, folderId));
        if (kind) conditions.push(eq(artifacts.kind, kind));
        if (artifactClass) conditions.push(eq(artifacts.artifactClass, artifactClass));
        if (importance) conditions.push(eq(artifacts.importance, importance));
        if (contentType) conditions.push(eq(artifacts.contentType, contentType));
        if (customerId) conditions.push(eq(artifacts.customerId, customerId));
        if (agentId) conditions.push(eq(artifacts.agentId, agentId));
        if (isCanonical === "true" || isCanonical === "false") {
            conditions.push(eq(artifacts.isCanonical, isCanonical === "true"));
        }

        const startDate = startDateParam ? new Date(startDateParam) : null;
        if (startDate && !Number.isNaN(startDate.getTime())) {
            conditions.push(gte(artifacts.createdAt, startDate));
        }
        const endDate = endDateParam ? new Date(endDateParam) : null;
        if (endDate && !Number.isNaN(endDate.getTime())) {
            conditions.push(lte(artifacts.createdAt, endDate));
        }

        if (search) {
            const likeValue = `%${search}%`;
            const searchCondition = or(
                ilike(artifacts.title, likeValue),
                ilike(artifacts.originalFilename, likeValue),
                ilike(artifacts.path, likeValue)
            );
            if (searchCondition) {
                conditions.push(searchCondition);
            }
        }

        const rows = await db.select({
            id: artifacts.id,
            title: artifacts.title,
            kind: artifacts.kind,
            artifactClass: artifacts.artifactClass,
            importance: artifacts.importance,
            contentType: artifacts.contentType,
            previewText: artifacts.previewText,
            storageUrl: artifacts.storageUrl,
            storageKey: artifacts.storageKey,
            sizeBytes: artifacts.sizeBytes,
            folderId: artifacts.folderId,
            path: artifacts.path,
            metadataJson: artifacts.metadataJson,
            isCanonical: artifacts.isCanonical,
            updatedAt: artifacts.updatedAt,
            createdAt: artifacts.createdAt,
            projectId: artifacts.projectId,
            customerId: artifacts.customerId,
            agentId: artifacts.agentId,
            taskId: artifacts.taskId,
            customerName: customers.name,
            projectGoal: projects.goal,
            taskType: tasks.taskType,
        })
            .from(artifacts)
            .leftJoin(projects, eq(projects.id, artifacts.projectId))
            .leftJoin(customers, eq(customers.id, artifacts.customerId))
            .leftJoin(tasks, eq(tasks.id, artifacts.taskId))
            .where(and(...conditions))
            .orderBy(desc(artifacts.createdAt))
            .limit(limit);

        return NextResponse.json({ artifacts: rows });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
    }
}
