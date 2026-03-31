import { NextRequest, NextResponse } from "next/server";
import { artifactFolders, projects, customers } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull, type InferModel } from "drizzle-orm";
import { requireCompanyFromSession } from "@/lib/company-session";
import { buildFolderPath, sanitizeFolderName, findActiveFolder } from "@/lib/artifact-folders";
import { ensureArtifactStorageSchema } from "@/lib/artifact-schema";

type ArtifactFolderRecord = InferModel<typeof artifactFolders>;

export async function POST(req: NextRequest) {
    try {
        const { companyId } = await requireCompanyFromSession();
        await ensureArtifactStorageSchema();
        const body = await req.json();
        const name = sanitizeFolderName(body.name);
        if (!name) {
            return NextResponse.json({ error: "Folder name is required" }, { status: 400 });
        }

        const parentFolderId = body.parentFolderId || null;
        const parentFolder = parentFolderId ? await findActiveFolder(companyId, parentFolderId) : null;
        if (parentFolderId && !parentFolder) {
            return NextResponse.json({ error: "Parent folder not found" }, { status: 404 });
        }

        const projectId = await resolveScopedProject(companyId, body.projectId);
        const customerId = await resolveScopedCustomer(companyId, body.customerId);

        const parentPathValue = parentFolder && typeof parentFolder.path === "string" ? parentFolder.path : null;
        const safeName = typeof name === "string" ? name : "";
        const folderPath = buildFolderPath(parentPathValue, safeName);
        const existing = await db.select().from(artifactFolders).where(and(
            eq(artifactFolders.companyId, companyId),
            eq(artifactFolders.path, folderPath),
            isNull(artifactFolders.deletedAt),
        )).limit(1);
        if (existing.length > 0) {
            return NextResponse.json({ error: "Folder already exists at this path" }, { status: 409 });
        }

        const inserted = await db.insert(artifactFolders).values({
            companyId,
            customerId,
            projectId,
            parentFolderId,
            name,
            path: folderPath,
            kind: body.kind || "folder",
            metadataJson: body.metadataJson || {},
            createdByType: "human",
            createdById: null,
        }).returning();

        const [folder] = (inserted as ArtifactFolderRecord[]);

        return NextResponse.json({ folder }, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
    }
}

async function resolveScopedProject(companyId: string, projectId?: string | null) {
    if (!projectId) return null;
    const [project] = await db.select().from(projects).where(and(
        eq(projects.id, projectId),
        eq(projects.companyId, companyId),
        isNull(projects.deletedAt),
    )).limit(1);
    if (!project) {
        throw new Error("Project not found");
    }
    return project.id;
}

async function resolveScopedCustomer(companyId: string, customerId?: string | null) {
    if (!customerId) return null;
    const [customer] = await db.select().from(customers).where(and(
        eq(customers.id, customerId),
        eq(customers.companyId, companyId),
        isNull(customers.deletedAt),
    )).limit(1);
    if (!customer) {
        throw new Error("Customer not found");
    }
    return customer.id;
}
