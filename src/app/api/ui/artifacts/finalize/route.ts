import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { artifacts, projects, tasks } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { requireCompanyFromSession } from "@/lib/company-session";
import { storageAdapter } from "@/lib/storage";
import { findActiveFolder } from "@/lib/artifact-folders";
import { prepareArtifactRecord } from "@/lib/artifacts";
import { buildChildPath } from "@/lib/path-utils";

export async function POST(req: NextRequest) {
    try {
        const { companyId, userId } = await requireCompanyFromSession();
        const body = await req.json();
        const {
            projectId,
            taskId,
            kind,
            contentType,
            logicalPath,
            folderId,
            title,
            artifactClass,
            importance,
            metadataJson,
            visibility,
            retentionPolicy,
            filename,
        } = body;

        if (!projectId || !taskId || !kind || !contentType) {
            return NextResponse.json({ error: "projectId, taskId, kind, and contentType are required" }, { status: 400 });
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
            return NextResponse.json({ error: "Task does not belong to the project" }, { status: 400 });
        }

        const folder = folderId ? await findActiveFolder(companyId, folderId) : null;
        if (folderId && !folder) {
            return NextResponse.json({ error: "Folder not found" }, { status: 404 });
        }

        const fallbackName = filename || title || "artifact";
        const defaultPath = folder ? buildChildPath(folder.path, fallbackName) : fallbackName;
        const resolvedPath = logicalPath || defaultPath;
        if (!resolvedPath) {
            return NextResponse.json({ error: "logicalPath or filename/title is required" }, { status: 400 });
        }

        const download = await storageAdapter.download({
            companyId,
            logicalPath: resolvedPath,
        });

        const checksum = createHash("sha256").update(download.buffer).digest("hex");
        const storageUrl = storageAdapter.getDownloadUrl({ companyId, logicalPath: resolvedPath });
        const storageKey = storageAdapter.buildStorageKey(companyId, resolvedPath);

        const prepared = prepareArtifactRecord({
            kind,
            artifactClass,
            importance,
            title: title || filename || resolvedPath,
            contentType: contentType || download.contentType || "application/octet-stream",
            storageProvider: "bunny",
            storageUrl,
            storageKey,
            originalFilename: filename || title || null,
            sha256: checksum,
            sizeBytes: download.sizeBytes,
            metadataJson,
        });

        const [artifact] = await db.insert(artifacts).values({
            companyId,
            projectId,
            taskId,
            folderId: folder ? folder.id : null,
            path: resolvedPath,
            ...prepared,
            createdByType: "human",
            createdById: userId,
            visibility: visibility || "private",
            retentionPolicy: retentionPolicy || null,
        }).returning();

        return NextResponse.json({ message: "Artifact finalized", artifact }, { status: 201 });
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
