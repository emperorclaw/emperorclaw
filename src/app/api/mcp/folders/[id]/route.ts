import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { artifactFolders, artifacts, projects, customers } from "@/db/schema";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { buildFolderPath, isDescendantPath, sanitizeFolderName, findActiveFolder } from "@/lib/artifact-folders";
import { ensureArtifactStorageSchema } from "@/lib/artifact-schema";
import { moveFolderArtifactBlobs } from "@/lib/folder-artifact-moves";
import { storageAdapter } from "@/lib/storage";

export async function GET(req: NextRequest, context: RouteContext<"/api/mcp/folders/[id]">) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    await ensureArtifactStorageSchema();
    const { id: folderId } = await context.params;
    const folder = await findActiveFolder(companyId, folderId);
    if (!folder) {
        return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }
    return NextResponse.json({ folder });
}

export async function PATCH(req: NextRequest, context: RouteContext<"/api/mcp/folders/[id]">) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    try {
        const companyId = auth.companyToken!.companyId;
        await ensureArtifactStorageSchema();
        const { id: folderId } = await context.params;
        const folder = await findActiveFolder(companyId, folderId);
        if (!folder) {
            return NextResponse.json({ error: "Folder not found" }, { status: 404 });
        }

        const body = await req.json();
        const newName = body.name ? sanitizeFolderName(body.name) : folder.name;
        if (!newName) {
            return NextResponse.json({ error: "Folder name cannot be empty" }, { status: 400 });
        }

        const targetParentId =
            body.parentFolderId === undefined
                ? folder.parentFolderId
                : body.parentFolderId;
        const parentFolder = targetParentId ? await findActiveFolder(companyId, targetParentId) : null;
        if (targetParentId && !parentFolder) {
            return NextResponse.json({ error: "Parent folder not found" }, { status: 404 });
        }

        const parentPathString = parentFolder && typeof parentFolder.path === "string" ? parentFolder.path : null;
        const folderPathString = typeof folder.path === "string" ? folder.path : "";
        if (parentFolder && parentPathString && isDescendantPath(parentPathString, folderPathString)) {
            return NextResponse.json({ error: "Cannot move folder inside its own subtree" }, { status: 400 });
        }

        const resolvedProjectId = await resolveProjectUpdate(companyId, body.projectId);
        const resolvedCustomerId = await resolveCustomerUpdate(companyId, body.customerId);
        const resolvedAgentId = await resolveAgentUpdate(companyId, body.agentId);

        const finalParentId = parentFolder ? parentFolder.id : null;
        const parentFolderPath = parentFolder && typeof parentFolder.path === "string" ? parentFolder.path : null;
        const folderPathValue = typeof folder.path === "string" ? folder.path : "";
        const safeNewName = typeof newName === "string" ? newName : "";
        const newPath = buildFolderPath(parentFolderPath, safeNewName);
        const pathChanged = newPath !== folderPathValue;
        const affectedArtifacts = pathChanged
            ? await db.select({
                id: artifacts.id,
                path: artifacts.path,
                storageKey: artifacts.storageKey,
                storageUrl: artifacts.storageUrl,
                contentType: artifacts.contentType,
                sizeBytes: artifacts.sizeBytes,
                sha256: artifacts.sha256,
            }).from(artifacts).where(and(
                eq(artifacts.companyId, companyId),
                like(artifacts.path, `${folderPathValue}/%`),
                isNull(artifacts.deletedAt),
            ))
            : [];
        const movedArtifacts = pathChanged
            ? await moveFolderArtifactBlobs({
                companyId,
                artifacts: affectedArtifacts.map((artifact) => ({
                    id: artifact.id,
                    path: artifact.path,
                    storageKey: artifact.storageKey,
                    storageUrl: artifact.storageUrl,
                    contentType: artifact.contentType,
                    sizeBytes: artifact.sizeBytes,
                    sha256: artifact.sha256,
                })),
                fromPrefix: folderPathValue,
                toPrefix: newPath,
            })
            : [];

        const result = await db.transaction(async (tx) => {
            const [updatedFolder] = await tx.update(artifactFolders).set({
                name: newName,
                parentFolderId: finalParentId,
                path: newPath,
                metadataJson: body.metadataJson ?? folder.metadataJson,
                projectId: resolvedProjectId === undefined ? folder.projectId : resolvedProjectId,
                customerId: resolvedCustomerId === undefined ? folder.customerId : resolvedCustomerId,
                agentId: resolvedAgentId === undefined ? folder.agentId : resolvedAgentId,
                updatedAt: new Date(),
            }).where(and(
                eq(artifactFolders.id, folder.id),
                eq(artifactFolders.companyId, companyId),
            )).returning();

            if (pathChanged) {
                const matchPattern = `${folderPathValue || ""}/%`;
                await tx.update(artifactFolders).set({
                    path: sql`regexp_replace(${artifactFolders.path}, ${folder.path}, ${newPath}, 'g')`,
                }).where(and(
                    eq(artifactFolders.companyId, companyId),
                    like(artifactFolders.path, matchPattern),
                ));

                for (const artifact of movedArtifacts) {
                    await tx.update(artifacts).set({
                        path: artifact.nextLogicalPath,
                        storageKey: artifact.storageKey,
                        storageUrl: artifact.storageUrl,
                        sizeBytes: artifact.sizeBytes,
                        sha256: artifact.sha256,
                        contentType: artifact.contentType,
                        updatedAt: new Date(),
                    }).where(and(
                        eq(artifacts.id, artifact.id),
                        eq(artifacts.companyId, companyId),
                    ));
                }
            }

            return updatedFolder;
        });

        return NextResponse.json({ folder: result }, { status: 200 });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: mapErrorStatus(error) });
    }
}

export async function DELETE(req: NextRequest, context: RouteContext<"/api/mcp/folders/[id]">) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    await ensureArtifactStorageSchema();
    const { id: folderId } = await context.params;
    const folder = await findActiveFolder(companyId, folderId);
    if (!folder) {
        return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }

    // Collect all artifacts in this folder tree that have a Bunny blob before wiping DB records.
    const matchPattern = `${folder.path}/%`;
    const artifactsToDelete = await db
        .select({ id: artifacts.id, path: artifacts.path, storageKey: artifacts.storageKey })
        .from(artifacts)
        .where(and(
            eq(artifacts.companyId, companyId),
            like(artifacts.path, matchPattern),
            isNull(artifacts.deletedAt),
        ));

    // Purge blobs from Bunny. Failures are logged but never block the DB delete.
    await Promise.allSettled(
        artifactsToDelete
            .filter((a) => a.storageKey && a.path)
            .map((a) =>
                storageAdapter.delete({ companyId, logicalPath: a.path! }).catch((err) =>
                    console.warn(`Failed to purge blob for artifact ${a.id}:`, err)
                )
            )
    );

    const now = new Date();
    await db.transaction(async (tx) => {
        await tx.update(artifactFolders).set({ deletedAt: now }).where(and(
            eq(artifactFolders.id, folder.id),
            eq(artifactFolders.companyId, companyId),
        ));

        await tx.update(artifactFolders).set({ deletedAt: now }).where(and(
            eq(artifactFolders.companyId, companyId),
            like(artifactFolders.path, matchPattern),
        ));

        await tx.update(artifacts).set({ deletedAt: now, storageKey: null, storageUrl: null }).where(and(
            eq(artifacts.companyId, companyId),
            like(artifacts.path, matchPattern),
        ));
    });

    return NextResponse.json({ success: true });
}

async function resolveProjectUpdate(companyId: string, value?: string | null) {
    if (value === undefined) {
        return undefined;
    }
    if (value === null) {
        return null;
    }
    const [project] = await db.select().from(projects).where(and(
        eq(projects.id, value),
        eq(projects.companyId, companyId),
        isNull(projects.deletedAt),
    )).limit(1);
    if (!project) {
        throw new Error("Project not found");
    }
    return project.id;
}

async function resolveCustomerUpdate(companyId: string, value?: string | null) {
    if (value === undefined) {
        return undefined;
    }
    if (value === null) {
        return null;
    }
    const [customer] = await db.select().from(customers).where(and(
        eq(customers.id, value),
        eq(customers.companyId, companyId),
        isNull(customers.deletedAt),
    )).limit(1);
    if (!customer) {
        throw new Error("Customer not found");
    }
    return customer.id;
}

async function resolveAgentUpdate(companyId: string, value?: string | null) {
    if (value === undefined) {
        return undefined;
    }
    if (value === null || value === "") {
        return null;
    }
    return await resolveAgentId(companyId, value);
}

function mapErrorStatus(error: unknown) {
    if (error instanceof Error) {
        const normalized = error.message.toLowerCase();
        if (normalized.includes("not found")) {
            return 404;
        }
    }
    return 500;
}
