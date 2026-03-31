import { NextRequest, NextResponse } from "next/server";
import { artifactFolders, artifacts, projects, customers } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { requireCompanyFromSession } from "@/lib/company-session";
import { buildFolderPath, findActiveFolder, isDescendantPath, sanitizeFolderName } from "@/lib/artifact-folders";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
    try {
        const { companyId } = await requireCompanyFromSession();
        const folder = await findActiveFolder(companyId, params.id);
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

        if (parentFolder && isDescendantPath(parentFolder.path, folder.path)) {
            return NextResponse.json({ error: "Cannot move folder inside its own subtree" }, { status: 400 });
        }

        const newPath = buildFolderPath(parentFolder?.path ?? null, newName);
        const pathChanged = newPath !== folder.path;

        const resolvedProjectId = await resolveProjectUpdate(companyId, body.projectId);
        const resolvedCustomerId = await resolveCustomerUpdate(companyId, body.customerId);

        const [updatedFolder] = await db.transaction(async (tx) => {
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
                const matchPattern = `${folder.path}/%`;
                await tx.update(artifactFolders).set({
                    path: sql`regexp_replace(${artifactFolders.path}, ${folder.path}, ${newPath}, 'g')`,
                }).where(and(
                    eq(artifactFolders.companyId, companyId),
                    like(artifactFolders.path, matchPattern),
                ));

                await tx.update(artifacts).set({
                    path: sql`regexp_replace(${artifacts.path}, ${folder.path}, ${newPath}, 'g')`,
                }).where(and(
                    eq(artifacts.companyId, companyId),
                    like(artifacts.path, matchPattern),
                ));
            }

            return folderRow;
        });

        return NextResponse.json({ folder: updatedFolder }, { status: 200 });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
    }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
    try {
        const { companyId } = await requireCompanyFromSession();
        const folder = await findActiveFolder(companyId, params.id);
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
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
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
