import { NextRequest, NextResponse } from "next/server";
import { prepareArtifactRecord } from "@/lib/artifacts";
import { requireCompanyFromSession } from "@/lib/company-session";
import { db } from "@/db";
import { artifacts, projects, tasks } from "@/db/schema";
import { storageAdapter } from "@/lib/storage";
import { findActiveFolder } from "@/lib/artifact-folders";
import { and, eq, isNull } from "drizzle-orm";
import { getFormStringValue, parseJsonMetadata } from "@/lib/form-utils";
import { ensureArtifactStorageSchema } from "@/lib/artifact-schema";

export async function POST(req: NextRequest) {
    try {
        const { companyId, userId } = await requireCompanyFromSession();
        await ensureArtifactStorageSchema();
        const form = await req.formData();
        const fileEntry = form.get("file");
        if (!(fileEntry instanceof File)) {
            return NextResponse.json({ error: "A file upload is required under the 'file' field" }, { status: 400 });
        }

        const projectId = getFormStringValue(form, "projectId");
        const taskId = getFormStringValue(form, "taskId");
        const kind = getFormStringValue(form, "kind") || "report";
        if (!projectId || !taskId || !kind) {
            return NextResponse.json({ error: "projectId, taskId, and kind are required" }, { status: 400 });
        }

        const project = await loadProject(companyId, projectId);
        if (!project) {
            return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }

        const task = await loadTask(companyId, taskId);
        if (!task) {
            return NextResponse.json({ error: "Task not found" }, { status: 404 });
        }
        if (task.projectId !== projectId) {
            return NextResponse.json({ error: "Task does not belong to the specified project" }, { status: 400 });
        }

        const folderId = getFormStringValue(form, "folderId");
        const folder = folderId ? await findActiveFolder(companyId, folderId) : null;
        if (folderId && !folder) {
            return NextResponse.json({ error: "Folder not found" }, { status: 404 });
        }

        const title = getFormStringValue(form, "title") || fileEntry.name;
        const artifactClass = getFormStringValue(form, "artifactClass");
        const importance = getFormStringValue(form, "importance");
        const logicalPath = folder ? `${folder.path}/${fileEntry.name}` : fileEntry.name;
        const contentType =
            getFormStringValue(form, "contentType") ||
            fileEntry.type ||
            "application/octet-stream";

        const metadataJson = parseJsonMetadata(form.get("metadataJson"));
        const checksum = getFormStringValue(form, "checksum");
        const buffer = Buffer.from(await fileEntry.arrayBuffer());

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
            projectId,
            taskId,
            folderId: folder ? folder.id : null,
            customerId: project.customerId,
            path: logicalPath,
            ...preparedArtifact,
            createdByType: "human",
            createdById: userId,
            visibility,
            retentionPolicy: retentionPolicy || null,
        }).returning();

        return NextResponse.json({ message: "Artifact uploaded", artifact }, { status: 201 });
    } catch (error) {
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
