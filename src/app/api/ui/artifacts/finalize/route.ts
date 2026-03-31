import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { artifacts, customers, projects, tasks } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { requireCompanyFromSession } from "@/lib/company-session";
import { storageAdapter } from "@/lib/storage";
import { findActiveFolder } from "@/lib/artifact-folders";
import { prepareArtifactRecord } from "@/lib/artifacts";
import { buildChildPath } from "@/lib/path-utils";
import { ensureArtifactStorageSchema } from "@/lib/artifact-schema";

export async function POST(req: NextRequest) {
    try {
        const { companyId, userId } = await requireCompanyFromSession();
        await ensureArtifactStorageSchema();
        const body = await req.json();
        const {
            projectId,
            taskId,
            customerId,
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

        if (!kind || !contentType) {
            return NextResponse.json({ error: "kind and contentType are required" }, { status: 400 });
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
            return NextResponse.json({ error: "Task does not belong to the project" }, { status: 400 });
        }

        const customer = customerId ? await loadCustomer(companyId, customerId) : null;
        if (customerId && !customer) {
            return NextResponse.json({ error: "Customer not found" }, { status: 404 });
        }
        if (!project && !customer) {
            return NextResponse.json({ error: "Select a customer or project" }, { status: 400 });
        }

        const folder = folderId ? await findActiveFolder(companyId, folderId) : null;
        if (folderId && !folder) {
            return NextResponse.json({ error: "Folder not found" }, { status: 404 });
        }

        const fallbackName = filename || title || "artifact";
        const folderPathValue = folder && typeof folder.path === "string" ? folder.path : null;
        const defaultPath = folderPathValue ? buildChildPath(folderPathValue, fallbackName) : fallbackName;
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
            projectId: project?.id ?? null,
            taskId: task?.id ?? null,
            folderId: folder ? folder.id : null,
            customerId: project?.customerId ?? customer?.id ?? null,
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

async function loadCustomer(companyId: string, customerId: string) {
    const [customer] = await db.select().from(customers).where(and(
        eq(customers.id, customerId),
        eq(customers.companyId, companyId),
        isNull(customers.deletedAt),
    )).limit(1);
    return customer || null;
}
