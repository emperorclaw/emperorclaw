import { NextRequest, NextResponse } from "next/server";
import { prepareArtifactRecord } from "@/lib/artifacts";
import {
    verifyMcpToken,
    checkIdempotency,
    saveIdempotencyResponse,
    logAudit,
    resolveAgentId,
} from "@/lib/mcp";
import { db } from "@/db";
import { artifacts, customers, projects, tasks } from "@/db/schema";
import { storageAdapter } from "@/lib/storage";
import { findActiveFolder } from "@/lib/artifact-folders";
import { and, eq, isNull } from "drizzle-orm";
import { getFormStringValue, parseJsonMetadata } from "@/lib/form-utils";
import { ensureArtifactStorageSchema } from "@/lib/artifact-schema";
import {
    ArtifactStorageQuotaError,
    assertCanStoreArtifactBytes,
} from "@/lib/artifact-quota";

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const companyId = auth.companyToken!.companyId;

    const idempotency = await checkIdempotency(req, companyId, "/api/mcp/artifacts/upload");
    if ("error" in idempotency) {
        return NextResponse.json({ error: idempotency.error }, { status: idempotency.status });
    }
    if ("cachedResponse" in idempotency) {
        return NextResponse.json(idempotency.cachedResponse);
    }
    const { requestHash } = idempotency;

    try {
        await ensureArtifactStorageSchema();
        const form = await req.formData();
        const fileEntry = form.get("file");
        if (!(fileEntry instanceof File)) {
            return NextResponse.json({ error: "A file upload is required under the 'file' field" }, { status: 400 });
        }

        const projectId = getFormStringValue(form, "projectId");
        const taskId = getFormStringValue(form, "taskId");
        const customerId = getFormStringValue(form, "customerId");
        const kind = getFormStringValue(form, "kind");
        if (!kind) {
            return NextResponse.json({ error: "kind is required" }, { status: 400 });
        }

        const project = projectId ? await loadProject(companyId, projectId) : null;
        if (projectId && !project) {
            return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }

        if (taskId && !projectId) {
            return NextResponse.json({ error: "taskId requires projectId" }, { status: 400 });
        }

        const task = taskId ? await loadTask(companyId, taskId) : null;
        if (taskId && !task) {
            return NextResponse.json({ error: "Task not found" }, { status: 404 });
        }
        if (task && projectId && task.projectId !== projectId) {
            return NextResponse.json({ error: "Task does not belong to the specified project" }, { status: 400 });
        }

        const customer = customerId ? await loadCustomer(companyId, customerId) : null;
        if (customerId && !customer) {
            return NextResponse.json({ error: "Customer not found" }, { status: 404 });
        }
        if (!project && !customer) {
            return NextResponse.json({ error: "customerId or projectId is required" }, { status: 400 });
        }

        const folderId = getFormStringValue(form, "folderId");
        const folder = folderId ? await findActiveFolder(companyId, folderId) : null;
        if (folderId && !folder) {
            return NextResponse.json({ error: "Folder not found" }, { status: 404 });
        }

        const agentId = getFormStringValue(form, "agentId");
        const internalAgentId = agentId ? await resolveAgentId(companyId, agentId) : null;

        const metadataJson = parseJsonMetadata(form.get("metadataJson"));
        const title = getFormStringValue(form, "title") || fileEntry.name;
        const artifactClass = getFormStringValue(form, "artifactClass");
        const importance = getFormStringValue(form, "importance");

        const logicalPath = folder ? `${folder.path}/${fileEntry.name}` : fileEntry.name;
        const contentType =
            getFormStringValue(form, "contentType") ||
            fileEntry.type ||
            "application/octet-stream";

        const checksum = getFormStringValue(form, "checksum");
        const buffer = Buffer.from(await fileEntry.arrayBuffer());

        await assertCanStoreArtifactBytes({
            companyId,
            incomingSizeBytes: buffer.length,
        });

        const uploadResult = await storageAdapter.upload({
            companyId,
            logicalPath,
            data: buffer,
            contentType,
            checksum: checksum || undefined,
        });

        const preparedArtifact = prepareArtifactRecord({
            kind,
            artifactClass,
            importance,
            title,
            contentType: uploadResult.contentType,
            storageProvider: "bunny",
            storageUrl: uploadResult.storageUrl,
            storageKey: uploadResult.storageKey,
            originalFilename: fileEntry.name,
            sha256: uploadResult.checksum,
            sizeBytes: uploadResult.sizeBytes,
            metadataJson,
        });

        const visibility = getFormStringValue(form, "visibility") || "private";
        const retentionPolicy = getFormStringValue(form, "retentionPolicy");

        const [artifact] = await db.insert(artifacts).values({
            companyId,
            projectId: project?.id ?? null,
            taskId: task?.id ?? null,
            folderId: folder ? folder.id : null,
            customerId: project?.customerId ?? customer?.id ?? null,
            agentId: internalAgentId,
            path: logicalPath,
            ...preparedArtifact,
            createdByType: "agent",
            createdById: internalAgentId,
            visibility,
            retentionPolicy: retentionPolicy || null,
        }).returning();
        const artifactIdValue = artifact.id as string;

        await logAudit(companyId, "agent", internalAgentId, "upload_artifact", "artifact", artifactIdValue, {
            kind,
            projectId,
            taskId,
            folderId: folder?.id ?? null,
            logicalPath,
        });

        const response = { message: "Artifact uploaded", artifact };
        await saveIdempotencyResponse(
            companyId,
            "/api/mcp/artifacts/upload",
            requestHash,
            response
        );

        return NextResponse.json(response, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: mapErrorStatus(error) });
    }
}

async function loadProject(companyId: string, projectId: string) {
    const [project] = await db.select().from(projects).where(and(
        eq(projects.id, projectId),
        eq(projects.companyId, companyId),
        isNull(projects.deletedAt),
    )).limit(1);
    return project || null;
}

async function loadTask(companyId: string, taskId: string) {
    const [task] = await db.select().from(tasks).where(and(
        eq(tasks.id, taskId),
        eq(tasks.companyId, companyId),
        isNull(tasks.deletedAt),
    )).limit(1);
    return task || null;
}

async function loadCustomer(companyId: string, customerId: string) {
    const [customer] = await db.select().from(customers).where(and(
        eq(customers.id, customerId),
        eq(customers.companyId, companyId),
        isNull(customers.deletedAt),
    )).limit(1);
    return customer || null;
}

function mapErrorStatus(error: unknown) {
    if (error instanceof ArtifactStorageQuotaError) {
        return 413;
    }
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes("not found")) {
            return 404;
        }
    }
    return 500;
}
