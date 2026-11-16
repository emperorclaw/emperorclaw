import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { artifactFolders, artifacts, projects, customers, tasks } from "@/db/schema";
import { and, desc, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import { requireCompanyFromSession } from "@/lib/company-session";
import { memberMaySeeRecord, memberRecordCondition } from "@/lib/member-scope";
import { findActiveFolder } from "@/lib/artifact-folders";
import { humanMayViewFolder } from "@/lib/artifact-visibility";
import { humanArtifactCondition, humanFolderCondition } from "@/lib/artifact-visibility-server";
import { discoverDirectStorageEntries, isStorageDiscoveryEnabled } from "@/lib/storage/discovery";
import { reconcileTrackedLocalArtifacts } from "@/lib/storage/artifact-reconciliation";

type FolderDto = {
    id: string;
    name: string;
    path: string;
    kind: string;
    ownerUserId: string | null;
    projectId: string | null;
    customerId: string | null;
    metadataJson: Record<string, unknown>;
};

export async function GET(req: NextRequest) {
    try {
        const { companyId, userId, role, scope } = await requireCompanyFromSession("viewer");
        const viewer = { userId, role };
        const { searchParams } = new URL(req.url);
        const folderId = searchParams.get("folderId");
        const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "100", 10), 1), 500);
        const search = searchParams.get("search");

        const folder = folderId
            ? await findActiveFolder(companyId, folderId)
            : null;

        // Another person's uploads folder reads as missing (lib/artifact-visibility.ts).
        if (folder && (!(await memberMaySeeRecord(companyId, scope, { projectId: folder.projectId as string | null, customerId: folder.customerId as string | null }))
            || !humanMayViewFolder(folder, viewer))) {

            return NextResponse.json({ error: "Folder not found" }, { status: 404 });

        }

        const parentFolderIdValue = folder && typeof folder.parentFolderId === "string" ? folder.parentFolderId : null;
        const ancestors = folder ? await buildAncestors(companyId, parentFolderIdValue) : [];
        const folderDto: FolderDto = folder
            ? {
                id: folder.id as string,
                name: folder.name as string,
                path: folder.path as string,
                kind: folder.kind,
                ownerUserId: folder.ownerUserId ?? null,
                projectId: typeof folder.projectId === "string" ? folder.projectId : null,
                customerId: typeof folder.customerId === "string" ? folder.customerId : null,
                metadataJson: folder.metadataJson as Record<string, unknown>,
            }
            : {
                id: "root",
                name: "Root",
                path: "",
                kind: "root",
                ownerUserId: null,
                projectId: null,
                customerId: null,
                metadataJson: {},
            };

        const folders = await db.select({
            id: artifactFolders.id,
            name: artifactFolders.name,
            path: artifactFolders.path,
            kind: artifactFolders.kind,
            ownerUserId: artifactFolders.ownerUserId,
            projectId: artifactFolders.projectId,
            customerId: artifactFolders.customerId,
            metadataJson: artifactFolders.metadataJson,
            createdAt: artifactFolders.createdAt,
        }).from(artifactFolders)
            .where(and(
                eq(artifactFolders.companyId, companyId),
                folder
                    ? eq(artifactFolders.parentFolderId, folder.id)
                    : isNull(artifactFolders.parentFolderId),
                isNull(artifactFolders.deletedAt),
                memberRecordCondition(scope, { projectId: artifactFolders.projectId, customerId: artifactFolders.customerId }),
                humanFolderCondition(viewer),
            ))
            .orderBy(artifactFolders.createdAt);

        const artifactConditions: SQL<unknown>[] = [
            eq(artifacts.companyId, companyId),
            isNull(artifacts.deletedAt),
        ];
        const scopedArtifacts = memberRecordCondition(scope, { projectId: artifacts.projectId, customerId: artifacts.customerId, projectCustomerId: projects.customerId });
        if (scopedArtifacts) artifactConditions.push(scopedArtifacts);
        const visibleArtifacts = humanArtifactCondition(viewer);
        if (visibleArtifacts) artifactConditions.push(visibleArtifacts);
        if (folder) {
            artifactConditions.push(eq(artifacts.folderId, folder.id));
        } else {
            artifactConditions.push(isNull(artifacts.folderId));
        }
        if (search) {
            const likeValue = `%${search}%`;
            const searchCondition = or(
                ilike(artifacts.title, likeValue),
                ilike(artifacts.originalFilename, likeValue),
                ilike(artifacts.path, likeValue),
            );
            if (searchCondition) {
                artifactConditions.push(searchCondition);
            }
        }

        const artifactRows = await db.select({
            id: artifacts.id,
            title: artifacts.title,
            kind: artifacts.kind,
            artifactClass: artifacts.artifactClass,
            importance: artifacts.importance,
            contentType: artifacts.contentType,
            contentText: artifacts.contentText,
            previewText: artifacts.previewText,
            originalFilename: artifacts.originalFilename,
            sizeBytes: artifacts.sizeBytes,
            sha256: artifacts.sha256,
            visibility: artifacts.visibility,
            metadataJson: artifacts.metadataJson,
            isCanonical: artifacts.isCanonical,
            updatedAt: artifacts.updatedAt,
            createdAt: artifacts.createdAt,
            folderId: artifacts.folderId,
            path: artifacts.path,
            projectId: projects.id,
            projectGoal: projects.goal,
            customerId: artifacts.customerId,
            customerName: customers.name,
            agentId: artifacts.agentId,
            taskId: tasks.id,
            taskType: tasks.taskType,
        }).from(artifacts)
            .leftJoin(projects, eq(projects.id, artifacts.projectId))
            .leftJoin(customers, eq(customers.id, artifacts.customerId))
            .leftJoin(tasks, eq(tasks.id, artifacts.taskId))
            .where(and(...artifactConditions))
            .orderBy(desc(artifacts.createdAt))
            .limit(limit);

        const reconciled = isStorageDiscoveryEnabled()
            ? await reconcileTrackedLocalArtifacts(companyId, artifactRows.map((artifact) => ({
                id: artifact.id,
                path: artifact.path,
                sizeBytes: artifact.sizeBytes,
                sha256: artifact.sha256,
                updatedAt: artifact.updatedAt,
            })))
            : new Map();
        const reconciledArtifactRows = artifactRows.map((artifact) => {
            const updated = reconciled.get(artifact.id);
            return updated ? { ...artifact, ...updated } : artifact;
        });
        // Files and folders hidden from this viewer are still registered: they
        // must not resurface as "discovered" untracked entries.
        const hiddenPaths = isStorageDiscoveryEnabled() ? await hiddenRegisteredPaths(companyId, folder?.id ?? null) : [];
        const registeredPaths = new Set([
            ...folders.map((child) => child.path),
            ...reconciledArtifactRows.map((artifact) => artifact.path).filter((value): value is string => Boolean(value)),
            ...hiddenPaths,
        ]);
        const discoveredEntries = (await discoverDirectStorageEntries({
            companyId,
            folderPath: folderDto.path,
        })).filter((entry) => !registeredPaths.has(entry.logicalPath));

        return NextResponse.json({
            folder: folderDto,
            ancestors,
            folders,
            artifacts: reconciledArtifactRows,
            discoveredEntries,
            discoveryEnabled: isStorageDiscoveryEnabled(),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : message.startsWith("Forbidden") ? 403 : 500 });
    }
}

/** Every live folder/file path directly in this folder, regardless of who may see it. */
async function hiddenRegisteredPaths(companyId: string, folderId: string | null): Promise<string[]> {
    const [folderRows, artifactRows] = await Promise.all([
        db.select({ path: artifactFolders.path }).from(artifactFolders).where(and(
            eq(artifactFolders.companyId, companyId),
            folderId ? eq(artifactFolders.parentFolderId, folderId) : isNull(artifactFolders.parentFolderId),
            isNull(artifactFolders.deletedAt),
        )),
        db.select({ path: artifacts.path }).from(artifacts).where(and(
            eq(artifacts.companyId, companyId),
            folderId ? eq(artifacts.folderId, folderId) : isNull(artifacts.folderId),
            isNull(artifacts.deletedAt),
        )),
    ]);
    return [...folderRows.map((row) => row.path), ...artifactRows.map((row) => row.path)]
        .filter((value): value is string => Boolean(value));
}

async function buildAncestors(companyId: string, parentFolderId: string | null) {
    const ancestors: Array<Pick<FolderDto, "id" | "name" | "path">> = [];
    let cursor = parentFolderId;
    while (cursor) {
        const [parent] = await db.select().from(artifactFolders).where(and(
            eq(artifactFolders.id, cursor),
            eq(artifactFolders.companyId, companyId),
            isNull(artifactFolders.deletedAt),
        )).limit(1);
        if (!parent) break;
        ancestors.unshift({
            id: parent.id as string,
            name: parent.name as string,
            path: parent.path as string,
        });
        cursor = typeof parent.parentFolderId === "string" ? parent.parentFolderId : null;
    }
    return ancestors;
}
