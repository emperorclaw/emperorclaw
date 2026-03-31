import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { artifactFolders, artifacts, projects, customers, tasks } from "@/db/schema";
import { and, eq, isNull, desc, ilike } from "drizzle-orm";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: folderId } = await params;
    const folder = await db.select().from(artifactFolders).where(and(
        eq(artifactFolders.companyId, companyId),
        eq(artifactFolders.id, folderId),
        isNull(artifactFolders.deletedAt),
    )).limit(1);

    if (folder.length === 0) {
        return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }

    const [currentFolder] = folder;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "100", 10), 1), 500);
    const query = searchParams.get("search");

    const folderRows = await db.select({
        id: artifactFolders.id,
        name: artifactFolders.name,
        path: artifactFolders.path,
        metadataJson: artifactFolders.metadataJson,
        createdAt: artifactFolders.createdAt,
    }).from(artifactFolders).where(and(
        eq(artifactFolders.companyId, companyId),
        eq(artifactFolders.parentFolderId, currentFolder.id),
        isNull(artifactFolders.deletedAt),
    )).orderBy(artifactFolders.name);

    const artifactConditions = [
        eq(artifacts.companyId, companyId),
        eq(artifacts.folderId, currentFolder.id),
        isNull(artifacts.deletedAt),
    ];
    if (query) {
        artifactConditions.push(ilike(artifacts.title, `%${query}%`));
    }

    const artifactRows = await db.select({
        id: artifacts.id,
        title: artifacts.title,
        kind: artifacts.kind,
        artifactClass: artifacts.artifactClass,
        importance: artifacts.importance,
        sizeBytes: artifacts.sizeBytes,
        contentType: artifacts.contentType,
        storageProvider: artifacts.storageProvider,
        storageKey: artifacts.storageKey,
        originalFilename: artifacts.originalFilename,
        createdAt: artifacts.createdAt,
        projectId: projects.id,
        projectGoal: projects.goal,
        customerId: customers.id,
        customerName: customers.name,
        taskId: tasks.id,
        taskType: tasks.taskType,
    }).from(artifacts)
        .leftJoin(projects, eq(projects.id, artifacts.projectId))
        .leftJoin(customers, eq(customers.id, projects.customerId))
        .leftJoin(tasks, eq(tasks.id, artifacts.taskId))
        .where(and(...artifactConditions))
        .orderBy(desc(artifacts.createdAt))
        .limit(limit);

    return NextResponse.json({
        folder: currentFolder,
        folders: folderRows,
        artifacts: artifactRows,
    });
}
