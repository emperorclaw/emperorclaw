import { NextRequest, NextResponse } from "next/server";
import { artifactFolders, artifacts, projects, customers } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { requireCompanyFromSession } from "@/lib/company-session";
import { buildFolderPath, findActiveFolder, isDescendantPath, sanitizeFolderName } from "@/lib/artifact-folders";
import { moveFolderArtifactBlobs } from "@/lib/folder-artifact-moves";

export async function PATCH(req: NextRequest, context: RouteContext<"/api/ui/folders/[id]">) {
    try {
        const { companyId } = await requireCompanyFromSession();
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

        const parentPath = parentFolder && typeof parentFolder.path === "string" ? parentFolder.path : null;
        const folderPathValue = typeof folder.path === "string" ? folder.path : "";
        if (parentFolder && parentPath && isDescendantPath(parentPath, folderPathValue)) {
            return NextResponse.json({ error: "Cannot move folder inside its own subtree" }, { status: 400 });
        }

        const parentPathValue = parentFolder && typeof parentFolder.path === "string" ? parentFolder.path : null;
        const safeNewName = typeof newName === "string" ? newName : "";
        const newPath = buildFolderPath(parentPathValue, safeNewName);
        const pathChanged = newPath !== folderPathValue;

        const resolvedProjectId = await resolveProjectUpdate(companyId, body.projectId);
        const resolvedCustomerId = await resolveCustomerUpdate(companyId, body.customerId);
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

        const updatedFolder = await db.transaction(async (tx) => {
            const [folderRow] = await tx.update(artifactFolders).set({
                name: newName,
                parentFolderId: parentFolder ? parentFolder.id : null,
                path: newPath,
                metadataJson: body.metadataJson ?? folder.metadataJson,
                projectId: resolvedProjectId === undefined ? folder.projectId : resolvedProjectId,
                customerId: resolvedCustomerId === undefined ? folder.customerId : resolvedCustomerId,
                updatedAt: new Date(),
            }).where(and(
                eq(artifactFolders.id, folder.id),
                eq(artifactFolders.companyId, companyId),
            )).returning();

                if (pathChanged) {
                const matchPattern = `${folderPathValue}/%`;
                await tx.update(artifactFolders).set({
                    path: sql`regexp_replace(${artifactFolders.path}, ${folderPathValue}, ${newPath}, 'g')`,
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

            return folderRow;
        });

        return NextResponse.json({ folder: updatedFolder }, { status: 200 });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : mapErrorStatus(error) });
    }
}

function mapErrorStatus(error: unknown) {
    if (error instanceof Error) {
        const normalized = error.message.toLowerCase();
        if (normalized.includes("not found")) {
            return 404;
        }
        if (normalized.includes("subtree")) {
            return 400;
        }
    }
    return 500;
}

export async function DELETE(req: NextRequest, context: RouteContext<"/api/ui/folders/[id]">) {
    try {
        const { companyId } = await requireCompanyFromSession();
        const { id: folderId } = await context.params;
        const folder = await findActiveFolder(companyId, folderId);
        if (!folder) {
            return NextResponse.json({ error: "Folder not found" }, { status: 404 });
        }

        const now = new Date();
        await db.transaction(async (tx) => {
            await tx.update(artifactFolders).set({ deletedAt: now }).where(and(
                eq(artifactFolders.id, folder.id),
                eq(artifactFolders.companyId, companyId),
            ));

            const matchPattern = `${folder.path}/%`;
            await tx.update(artifactFolders).set({ deletedAt: now }).where(and(
                eq(artifactFolders.companyId, companyId),
                like(artifactFolders.path, matchPattern),
            ));

            await tx.update(artifacts).set({ deletedAt: now }).where(and(
                eq(artifacts.companyId, companyId),
                like(artifacts.path, matchPattern),
            ));
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : mapErrorStatus(error) });
    }
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
