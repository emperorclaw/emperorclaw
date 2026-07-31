import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { artifactFolders, projects, customers } from "@/db/schema";
import { and, eq, isNull, ilike, or, desc, type InferModel, type SQL } from "drizzle-orm";
import { buildFolderPath, sanitizeFolderName, findActiveFolder } from "@/lib/artifact-folders";
import { storageAdapter } from "@/lib/storage";

const CREATED_BY_TYPE = "mcp";
type ArtifactFolderRecord = InferModel<typeof artifactFolders>;

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "100", 10), 1), 500);
    const parentFolderId = searchParams.get("parentFolderId");
    const projectId = searchParams.get("projectId");
    const customerId = searchParams.get("customerId");
    const agentId = searchParams.get("agentId");
    const search = searchParams.get("search");

    try {
        const conditions: SQL<unknown>[] = [
            eq(artifactFolders.companyId, companyId),
            isNull(artifactFolders.deletedAt),
        ];

        if (parentFolderId) {
            conditions.push(eq(artifactFolders.parentFolderId, parentFolderId));
        }
        if (projectId) {
            conditions.push(eq(artifactFolders.projectId, projectId));
        }
        if (customerId) {
            conditions.push(eq(artifactFolders.customerId, customerId));
        }
        if (agentId) {
            conditions.push(eq(artifactFolders.agentId, agentId));
        }
        if (search) {
            const likeValue = `%${search}%`;
            const searchCondition = or(
                ilike(artifactFolders.name, likeValue),
                ilike(artifactFolders.path, likeValue)
            );
            if (searchCondition) {
                conditions.push(searchCondition);
            }
        }

        const rows = await db.select({
            id: artifactFolders.id,
            name: artifactFolders.name,
            path: artifactFolders.path,
            parentFolderId: artifactFolders.parentFolderId,
            kind: artifactFolders.kind,
            customerId: artifactFolders.customerId,
            projectId: artifactFolders.projectId,
            agentId: artifactFolders.agentId,
            createdAt: artifactFolders.createdAt,
            updatedAt: artifactFolders.updatedAt,
        })
            .from(artifactFolders)
            .where(and(...conditions))
            .orderBy(desc(artifactFolders.createdAt))
            .limit(limit);

        return NextResponse.json({ folders: rows });
    } catch (e: unknown) {
        console.error("MCP Folders GET Error:", e);
        const details = e instanceof Error ? e.message : "Unknown error";
        return NextResponse.json({ error: "Internal server error", details }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    try {
        const companyId = auth.companyToken!.companyId;
        const body = await req.json();
        const name = sanitizeFolderName(body.name);
        if (!name) {
            return NextResponse.json({ error: "Folder name is required" }, { status: 400 });
        }

        const parentFolderId = body.parentFolderId || null;
        const parentFolder = parentFolderId
            ? await findActiveFolder(companyId, parentFolderId)
            : null;
        if (parentFolderId && !parentFolder) {
            return NextResponse.json({ error: "Parent folder not found" }, { status: 404 });
        }

        const projectId = await resolveScopedProject(companyId, body.projectId);
        const customerId = await resolveScopedCustomer(companyId, body.customerId);
        const agentId = body.agentId ? await resolveAgentId(companyId, body.agentId) : null;

        const safeParentPath = parentFolder && typeof parentFolder.path === "string" ? parentFolder.path : null;
        const safeName = typeof name === "string" ? name : "";
        const folderPath = buildFolderPath(safeParentPath, safeName);

        const existing = await db.select().from(artifactFolders)
            .where(and(
                eq(artifactFolders.companyId, companyId),
                eq(artifactFolders.path, folderPath),
                isNull(artifactFolders.deletedAt)
            ))
            .limit(1);

        if (existing.length > 0) {
            const [dup] = existing;
            return NextResponse.json({
                error: "Folder already exists at this path",
                existingFolder: { id: dup.id, name: dup.name, path: dup.path },
            }, { status: 409 });
        }

        await storageAdapter.ensureDirectory({ companyId, logicalPath: folderPath });

        const inserted = await db.insert(artifactFolders).values({
            companyId,
            customerId,
            projectId,
            agentId,
            parentFolderId,
            name,
            path: folderPath,
            kind: body.kind || "folder",
            metadataJson: body.metadataJson || {},
            createdByType: CREATED_BY_TYPE,
            createdById: null,
        }).returning();

        const [folder] = (inserted as ArtifactFolderRecord[]);

        return NextResponse.json({ folder }, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: mapErrorStatus(error) });
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

function mapErrorStatus(error: unknown) {
    if (error instanceof Error) {
        const normalized = error.message.toLowerCase();
        if (normalized.includes("not found")) {
            return 404;
        }
        if (normalized.includes("already exists")) {
            return 409;
        }
    }
    return 500;
}
