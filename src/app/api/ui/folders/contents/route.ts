import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { artifactFolders, artifacts, projects, customers, tasks } from "@/db/schema";
import { and, desc, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import { requireCompanyFromSession } from "@/lib/company-session";
import { findActiveFolder } from "@/lib/artifact-folders";

type FolderDto = {
    id: string;
    name: string;
    path: string;
    projectId: string | null;
    customerId: string | null;
    metadataJson: Record<string, unknown>;
};

export async function GET(req: NextRequest) {
    try {
        const { companyId } = await requireCompanyFromSession();
        const { searchParams } = new URL(req.url);
        const folderId = searchParams.get("folderId");
        const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "100", 10), 1), 500);
        const search = searchParams.get("search");

        const folder = folderId
            ? await findActiveFolder(companyId, folderId)
            : null;

        const parentFolderIdValue = folder && typeof folder.parentFolderId === "string" ? folder.parentFolderId : null;
        const ancestors = folder ? await buildAncestors(companyId, parentFolderIdValue) : [];
        const folderDto: FolderDto = folder
            ? {
                id: folder.id as string,
                name: folder.name as string,
                path: folder.path as string,
                projectId: typeof folder.projectId === "string" ? folder.projectId : null,
                customerId: typeof folder.customerId === "string" ? folder.customerId : null,
                metadataJson: folder.metadataJson as Record<string, unknown>,
            }
            : {
                id: "root",
                name: "Root",
                path: "",
                projectId: null,
                customerId: null,
                metadataJson: {},
            };

        const folders = await db.select({
            id: artifactFolders.id,
            name: artifactFolders.name,
            path: artifactFolders.path,
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
            ))
            .orderBy(artifactFolders.createdAt);

        const artifactConditions: SQL<unknown>[] = [
            eq(artifacts.companyId, companyId),
            isNull(artifacts.deletedAt),
        ];
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

        return NextResponse.json({
            folder: folderDto,
            ancestors,
            folders,
            artifacts: artifactRows,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
    }
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
