import { NextRequest, NextResponse } from "next/server";
import { prepareArtifactRecord } from "@/lib/artifacts";
import { requireCompanyFromSession } from "@/lib/company-session";
import { db } from "@/db";
import { artifacts, customers, projects, tasks } from "@/db/schema";
import { storageAdapter, getStorageProviderName } from "@/lib/storage";
import { findActiveFolder } from "@/lib/artifact-folders";
import { and, eq, isNull } from "drizzle-orm";
import { getFormStringValue, parseJsonMetadata } from "@/lib/form-utils";
import { sanitizeArtifactClientPayload } from "@/lib/artifacts";
import { sanitizeFilenameSegment } from "@/lib/storage/path-sanitizer";
import {
    ArtifactFileTooLargeError,
    ArtifactStorageQuotaError,
    assertArtifactIngressAllowed,
    buildArtifactFileTooLargeErrorResponse,
    buildArtifactQuotaErrorResponse,
} from "@/lib/artifact-quota";

export async function POST(req: NextRequest) {
    try {
        const { companyId, userId } = await requireCompanyFromSession();
        const form = await req.formData();
        const fileEntry = form.get("file");
        if (!(fileEntry instanceof File)) {
            return NextResponse.json({ error: "A file upload is required under the 'file' field" }, { status: 400 });
        }

        const projectId = getFormStringValue(form, "projectId");
        const taskId = getFormStringValue(form, "taskId");
        const customerId = getFormStringValue(form, "customerId");
        const kind = getFormStringValue(form, "kind") || "report";
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
            return NextResponse.json({ error: "Select a customer or project" }, { status: 400 });
        }

        const folderId = getFormStringValue(form, "folderId");
        const folder = folderId ? await findActiveFolder(companyId, folderId) : null;
        if (folderId && !folder) {
            return NextResponse.json({ error: "Folder not found" }, { status: 404 });
        }

        const title = getFormStringValue(form, "title") || fileEntry.name;
        const artifactClass = getFormStringValue(form, "artifactClass");
        const importance = getFormStringValue(form, "importance");
        const logicalPath = folder
            ? `${folder.path}/${sanitizeFilenameSegment(fileEntry.name)}`
            : sanitizeFilenameSegment(fileEntry.name);
        const contentType =
            getFormStringValue(form, "contentType") ||
            fileEntry.type ||
            "application/octet-stream";

        const metadataJson = parseJsonMetadata(form.get("metadataJson"));
        const checksum = getFormStringValue(form, "checksum");
        await assertArtifactIngressAllowed({
            companyId,
            incomingSizeBytes: fileEntry.size,
        });

        const buffer = Buffer.from(await fileEntry.arrayBuffer());

        let uploadCompleted = false;

        try {
            const uploadResult = await storageAdapter.upload({
                companyId,
                logicalPath,
                data: buffer,
                contentType,
                checksum: checksum || undefined,
            });
            uploadCompleted = true;

            const preparedArtifact = prepareArtifactRecord({
                kind,
                artifactClass,
                importance,
                title,
                contentType: uploadResult.contentType,
                storageProvider: getStorageProviderName(),
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
                path: logicalPath,
                ...preparedArtifact,
                createdByType: "human",
                createdById: userId,
                visibility,
                retentionPolicy: retentionPolicy || null,
            }).returning();

            return NextResponse.json({ message: "Artifact uploaded", artifact: sanitizeArtifactClientPayload(artifact) }, { status: 201 });
        } catch (error) {
            if (uploadCompleted) {
                try {
                    await storageAdapter.delete({ companyId, logicalPath });
                } catch (cleanupError) {
                    console.warn("Unable to clean up failed artifact upload:", cleanupError);
                }
            }
            throw error;
        }
    } catch (error) {
        if (error instanceof ArtifactFileTooLargeError) {
            return NextResponse.json(buildArtifactFileTooLargeErrorResponse(error), { status: 413 });
        }
        if (error instanceof ArtifactStorageQuotaError) {
            return NextResponse.json(buildArtifactQuotaErrorResponse(error), { status: 413 });
        }
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
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
