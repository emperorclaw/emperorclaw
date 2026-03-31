import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { artifacts, projects, tasks } from "@/db/schema";
import {
    verifyMcpToken,
    checkIdempotency,
    saveIdempotencyResponse,
    logAudit,
    resolveAgentId,
} from "@/lib/mcp";
import { and, desc, eq, ilike, isNull, or, gte, lte } from "drizzle-orm";
import { prepareArtifactRecord } from "@/lib/artifacts";
import { findActiveFolder } from "@/lib/artifact-folders";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "100", 10), 1), 500);
    const projectId = searchParams.get("projectId");
    const taskId = searchParams.get("taskId");
    const folderId = searchParams.get("folderId");
    const artifactClass = searchParams.get("artifactClass");
    const importance = searchParams.get("importance");
    const contentType = searchParams.get("contentType");
    const customerId = searchParams.get("customerId");
    const agentId = searchParams.get("agentId");
    const isCanonical = searchParams.get("isCanonical");
    const search = searchParams.get("search");
    const startDateParam = searchParams.get("startDate");
    const endDateParam = searchParams.get("endDate");

    try {
        const conditions: any[] = [
            eq(artifacts.companyId, companyId),
            isNull(artifacts.deletedAt),
        ];

        if (projectId) {
            conditions.push(eq(artifacts.projectId, projectId));
        }
        if (taskId) {
            conditions.push(eq(artifacts.taskId, taskId));
        }
        if (folderId) {
            conditions.push(eq(artifacts.folderId, folderId));
        }
        if (artifactClass) {
            conditions.push(eq(artifacts.artifactClass, artifactClass));
        }
        if (importance) {
            conditions.push(eq(artifacts.importance, importance));
        }
        if (contentType) {
            conditions.push(eq(artifacts.contentType, contentType));
        }
        if (agentId) {
            conditions.push(eq(artifacts.createdById, agentId));
        }
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
            conditions.push(or(
                ilike(artifacts.title, likeValue),
                ilike(artifacts.originalFilename, likeValue)
            ));
        }

        const customerCondition = customerId ? eq(projects.customerId, customerId) : null;

        const rows = await db.select({
            id: artifacts.id,
            title: artifacts.title,
            kind: artifacts.kind,
            artifactClass: artifacts.artifactClass,
            importance: artifacts.importance,
            contentType: artifacts.contentType,
            storageUrl: artifacts.storageUrl,
            storageKey: artifacts.storageKey,
            sizeBytes: artifacts.sizeBytes,
            folderId: artifacts.folderId,
            createdAt: artifacts.createdAt,
            projectId: projects.id,
            projectGoal: projects.goal,
            customerId: projects.customerId,
            taskId: tasks.id,
            taskType: tasks.taskType,
        })
            .from(artifacts)
            .leftJoin(projects, eq(projects.id, artifacts.projectId))
            .leftJoin(tasks, eq(tasks.id, artifacts.taskId))
            .where(customerCondition ? and(...conditions, customerCondition) : and(...conditions))
            .orderBy(desc(artifacts.createdAt))
            .limit(limit);

        return NextResponse.json({ artifacts: rows });
    } catch (e: unknown) {
        console.error("MCP Artifacts GET Error:", e);
        const details = e instanceof Error ? e.message : "Unknown error";
        return NextResponse.json({ error: "Internal server error", details }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const authResult = await verifyMcpToken(req);
    if ("error" in authResult) {
        return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const { companyToken } = authResult;
    const companyId = companyToken.companyId;

    const idempotencyResult = await checkIdempotency(req, companyId, "/api/mcp/artifacts");
    if ("error" in idempotencyResult) {
        return NextResponse.json({ error: idempotencyResult.error }, { status: idempotencyResult.status });
    }
    if ("cachedResponse" in idempotencyResult) {
        return NextResponse.json(idempotencyResult.cachedResponse);
    }
    const { requestHash } = idempotencyResult;

    try {
        const body = await req.json();
        const {
            projectId,
            taskId,
            kind,
            contentType,
            contentText,
            storageUrl,
            storageProvider,
            storageKey,
            originalFilename,
            sourceKind,
            sourceRef,
            sha256,
            sizeBytes,
            visibility,
            retentionPolicy,
            agentId,
            title,
            artifactClass,
            importance,
            isCanonical,
            metadataJson,
            folderId,
            path,
        } = body;

        let internalAgentId = null;
        if (agentId) {
            internalAgentId = await resolveAgentId(companyId, agentId);
        }

        if (!projectId || !taskId || !kind || !contentType) {
            return NextResponse.json({ error: "Missing required fields (projectId, taskId, kind, contentType)" }, { status: 400 });
        }

        const [project] = await db.select({ id: projects.id }).from(projects)
            .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
            .limit(1);
        if (!project) {
            return NextResponse.json({ error: "Project not found or unauthorized." }, { status: 404 });
        }

        const [task] = await db.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks)
            .where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId)))
            .limit(1);
        if (!task) {
            return NextResponse.json({ error: "Task not found or unauthorized." }, { status: 404 });
        }
        if (task.projectId !== projectId) {
            return NextResponse.json({ error: "Task does not belong to the specified project." }, { status: 400 });
        }

        const finalStorageProvider = storageProvider || (storageKey ? "bunny" : undefined);
        const folder = folderId ? await findActiveFolder(companyId, folderId) : null;
        if (folderId && !folder) {
            return NextResponse.json({ error: "Folder not found" }, { status: 404 });
        }

        const resolvedPath =
            path ||
            (folder
                ? `${folder.path}/${originalFilename || title || "artifact"}`
                : null);

        const preparedArtifact = prepareArtifactRecord({
            kind,
            artifactClass,
            importance,
            title,
            contentType,
            contentText,
            storageUrl,
            storageProvider: finalStorageProvider,
            storageKey,
            originalFilename,
            sourceKind,
            sourceRef,
            sha256,
            sizeBytes,
            isCanonical,
            metadataJson,
        });

        const [artifact] = await db.insert(artifacts).values({
            companyId,
            projectId,
            taskId,
            folderId: folder ? folder.id : null,
            path: resolvedPath,
            ...preparedArtifact,
            createdByType: "agent",
            createdById: internalAgentId || null,
            visibility: visibility || "private",
            retentionPolicy: retentionPolicy || null,
        }).returning();
        const artifactIdValue = artifact.id as string;

        await logAudit(companyId, "agent", internalAgentId || null, "create_artifact", "artifact", artifactIdValue, {
            kind,
            artifactClass: artifact.artifactClass,
            importance: artifact.importance,
            title: artifact.title,
            contentType,
            taskId,
            projectId,
            folderId: folder ? folder.id : null,
            path: resolvedPath,
        });

        const responseObj = { message: "Artifact saved", artifact };
        await saveIdempotencyResponse(companyId, "/api/mcp/artifacts", requestHash, responseObj);

        return NextResponse.json(responseObj, { status: 201 });
    } catch (e: unknown) {
        console.error("MCP Artifacts Error:", e);
        const details = e instanceof Error ? e.message : "Unknown error";
        return NextResponse.json({ error: "Internal server error", details }, { status: 500 });
    }
}
