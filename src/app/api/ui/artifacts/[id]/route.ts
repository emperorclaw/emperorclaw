import { NextRequest, NextResponse } from "next/server";
import { artifacts, customers, projects, tasks } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull, type InferModel } from "drizzle-orm";
import { prepareArtifactRecord } from "@/lib/artifacts";
import { sanitizeArtifactClientPayload } from "@/lib/artifacts";
import { requireCompanyFromSession } from "@/lib/company-session";

type ArtifactRecord = InferModel<typeof artifacts>;

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { companyId } = await requireCompanyFromSession();
        const { id: artifactId } = await params;

        const [artifact] = await db.select({
            id: artifacts.id,
            companyId: artifacts.companyId,
            projectId: artifacts.projectId,
            taskId: artifacts.taskId,
            folderId: artifacts.folderId,
            customerId: artifacts.customerId,
            agentId: artifacts.agentId,
            path: artifacts.path,
            title: artifacts.title,
            kind: artifacts.kind,
            artifactClass: artifacts.artifactClass,
            importance: artifacts.importance,
            contentType: artifacts.contentType,
            contentText: artifacts.contentText,
            previewText: artifacts.previewText,
            searchText: artifacts.searchText,
            storageProvider: artifacts.storageProvider,
            originalFilename: artifacts.originalFilename,
            sourceKind: artifacts.sourceKind,
            sourceRef: artifacts.sourceRef,
            sha256: artifacts.sha256,
            sizeBytes: artifacts.sizeBytes,
            visibility: artifacts.visibility,
            isCanonical: artifacts.isCanonical,
            promotedAt: artifacts.promotedAt,
            metadataJson: artifacts.metadataJson,
            retentionPolicy: artifacts.retentionPolicy,
            updatedAt: artifacts.updatedAt,
            createdAt: artifacts.createdAt,
            projectGoal: projects.goal,
            customerName: customers.name,
            taskType: tasks.taskType,
        }).from(artifacts)
            .leftJoin(projects, eq(projects.id, artifacts.projectId))
            .leftJoin(customers, eq(customers.id, artifacts.customerId))
            .leftJoin(tasks, eq(tasks.id, artifacts.taskId))
            .where(and(
                eq(artifacts.id, artifactId),
                eq(artifacts.companyId, companyId),
                isNull(artifacts.deletedAt),
            ))
            .limit(1);

        if (!artifact) {
            return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
        }

        return NextResponse.json({ artifact: sanitizeArtifactClientPayload(artifact) });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : mapErrorStatus(error) });
    }
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { companyId } = await requireCompanyFromSession();
        const { id: artifactId } = await params;
        const [artifact] = await db.select().from(artifacts).where(and(
            eq(artifacts.id, artifactId),
            eq(artifacts.companyId, companyId),
            isNull(artifacts.deletedAt),
        )).limit(1);
        if (!artifact) {
            return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
        }
        const artifactRecord = artifact as ArtifactRecord;

        const body = await req.json();
        const requestedProjectId = normalizeNullableId(body.projectId, artifactRecord.projectId as string | null);
        const requestedTaskId = normalizeNullableId(body.taskId, artifactRecord.taskId as string | null);
        const requestedCustomerId = normalizeNullableId(body.customerId, artifactRecord.customerId as string | null);

        const selectedProject = requestedProjectId
            ? await getProjectById(companyId, requestedProjectId)
            : null;
        const projectId = selectedProject?.id ?? null;
        const taskId = requestedTaskId
            ? await resolveTaskId(companyId, requestedTaskId, projectId)
            : null;
        const customerId = projectId
            ? selectedProject?.customerId ?? null
            : await resolveCustomerId(companyId, requestedCustomerId);

        if (!projectId && !customerId) {
            throw new Error("customerId or projectId is required");
        }

        const metadataJson = body.metadataJson ?? artifactRecord.metadataJson;
        const contentType = (body.contentType ?? artifactRecord.contentType) as string;
        const prepared = prepareArtifactRecord({
            kind: (body.kind ?? artifactRecord.kind) as string,
            artifactClass: (body.artifactClass ?? artifactRecord.artifactClass) as string | null,
            importance: (body.importance ?? artifactRecord.importance) as string | null,
            title: (body.title ?? artifactRecord.title) as string | null,
            contentType,
            contentText: (artifactRecord.contentText as string | null) ?? null,
            storageUrl: (artifactRecord.storageUrl as string | null) ?? null,
            storageProvider: (artifactRecord.storageProvider as string | null) ?? null,
            storageKey: (artifactRecord.storageKey as string | null) ?? null,
            originalFilename: (artifactRecord.originalFilename as string | null) ?? null,
            sourceKind: (artifactRecord.sourceKind as string | null) ?? null,
            sourceRef: (artifactRecord.sourceRef as string | null) ?? null,
            sha256: artifactRecord.sha256 as string,
            sizeBytes: artifactRecord.sizeBytes as number,
            isCanonical: body.isCanonical ?? artifactRecord.isCanonical,
            metadataJson,
        });

        const [updatedArtifact] = await db.update(artifacts).set({
            projectId,
            taskId,
            customerId,
            kind: prepared.kind,
            title: prepared.title,
            artifactClass: prepared.artifactClass,
            importance: prepared.importance,
            contentType: prepared.contentType,
            metadataJson: prepared.metadataJson,
            isCanonical: prepared.isCanonical,
            promotedAt: prepared.promotedAt,
            visibility: body.visibility ?? artifactRecord.visibility,
            retentionPolicy: body.retentionPolicy ?? artifactRecord.retentionPolicy,
            updatedAt: new Date(),
        }).where(and(
            eq(artifacts.id, artifactRecord.id),
            eq(artifacts.companyId, companyId),
        )).returning();

        return NextResponse.json({ artifact: sanitizeArtifactClientPayload(updatedArtifact) });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : mapErrorStatus(error) });
    }
}

async function getProjectById(companyId: string, projectId: string | null) {
    if (!projectId) {
        throw new Error("projectId is required");
    }
    const [project] = await db.select({
        id: projects.id,
        customerId: projects.customerId,
    }).from(projects).where(and(
        eq(projects.id, projectId),
        eq(projects.companyId, companyId),
        isNull(projects.deletedAt),
    )).limit(1);
    if (!project) {
        throw new Error("Project not found");
    }
    return project;
}

async function resolveTaskId(companyId: string, taskId: string | null, projectId: string | null) {
    if (!taskId) {
        return null;
    }
    if (!projectId) {
        throw new Error("taskId requires projectId");
    }
    const [task] = await db.select({
        id: tasks.id,
        projectId: tasks.projectId,
    }).from(tasks).where(and(
        eq(tasks.id, taskId),
        eq(tasks.companyId, companyId),
        isNull(tasks.deletedAt),
    )).limit(1);
    if (!task) {
        throw new Error("Task not found");
    }
    if (task.projectId !== projectId) {
        throw new Error("Task does not belong to the selected project");
    }
    return task.id;
}

async function resolveCustomerId(companyId: string, customerId: string | null) {
    if (customerId === null) {
        return null;
    }
    const [customer] = await db.select({
        id: customers.id,
    }).from(customers).where(and(
        eq(customers.id, customerId),
        eq(customers.companyId, companyId),
        isNull(customers.deletedAt),
    )).limit(1);
    if (!customer) {
        throw new Error("Customer not found");
    }
    return customer.id;
}

function normalizeNullableId(value: unknown, fallback: string | null) {
    if (value === undefined) {
        return fallback;
    }
    if (value === null || value === "") {
        return null;
    }
    return typeof value === "string" ? value : fallback;
}

function mapErrorStatus(error: unknown) {
    if (error instanceof Error) {
        const normalized = error.message.toLowerCase();
        if (normalized.includes("not found")) {
            return 404;
        }
        if (normalized.includes("required") || normalized.includes("does not belong")) {
            return 400;
        }
    }
    return 500;
}
