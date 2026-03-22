import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { artifacts, projects, tasks } from "@/db/schema";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, logAudit, resolveAgentId } from "@/lib/mcp";
import { and, desc, eq, isNull } from "drizzle-orm";
import { prepareArtifactRecord } from "@/lib/artifacts";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
    const projectId = searchParams.get("projectId");
    const taskId = searchParams.get("taskId");
    const artifactClass = searchParams.get("artifactClass");
    const importance = searchParams.get("importance");
    const isCanonical = searchParams.get("isCanonical");

    try {
        const conditions = [
            eq(artifacts.companyId, companyId),
            isNull(artifacts.deletedAt),
        ];
        if (projectId) {
            conditions.push(eq(artifacts.projectId, projectId));
        }
        if (taskId) {
            conditions.push(eq(artifacts.taskId, taskId));
        }
        if (artifactClass) {
            conditions.push(eq(artifacts.artifactClass, artifactClass));
        }
        if (importance) {
            conditions.push(eq(artifacts.importance, importance));
        }
        if (isCanonical === "true" || isCanonical === "false") {
            conditions.push(eq(artifacts.isCanonical, isCanonical === "true"));
        }

        const rows = await db.select()
            .from(artifacts)
            .where(and(...conditions))
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

        const preparedArtifact = prepareArtifactRecord({
            kind,
            artifactClass,
            importance,
            title,
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
            isCanonical,
            metadataJson,
        });

        const [artifact] = await db.insert(artifacts).values({
            companyId,
            projectId,
            taskId,
            ...preparedArtifact,
            createdByType: "agent",
            createdById: internalAgentId || null,
            visibility: visibility || "private",
            retentionPolicy: retentionPolicy || null,
        }).returning();

        await logAudit(companyId, "agent", internalAgentId || null, "create_artifact", "artifact", artifact.id, {
            kind,
            artifactClass: artifact.artifactClass,
            importance: artifact.importance,
            title: artifact.title,
            contentType,
            taskId,
            projectId,
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
