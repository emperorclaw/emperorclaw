import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, logAudit } from "@/lib/mcp";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { deriveArtifactLogicalPath, buildChildPath, sanitizePathSegment } from "@/lib/path-utils";
import { findActiveFolder } from "@/lib/artifact-folders";
import { relocateArtifactBlob } from "@/lib/artifact-storage";
import { ensureArtifactStorageSchema } from "@/lib/artifact-schema";

export async function PATCH(req: NextRequest, context: RouteContext<"/api/mcp/artifacts/[id]/move">) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    await ensureArtifactStorageSchema();
    const { id: artifactId } = await context.params;
    const [artifact] = await db.select().from(artifacts).where(and(
        eq(artifacts.id, artifactId),
        eq(artifacts.companyId, companyId),
        isNull(artifacts.deletedAt),
    )).limit(1);

    if (!artifact) {
        return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
    }
    const artifactIdValue = artifact.id as string;

    try {
        const body = await req.json();
        const folderId = body.folderId || null;
        const targetFolder = folderId ? await findActiveFolder(companyId, folderId) : null;
        if (folderId && !targetFolder) {
            return NextResponse.json({ error: "Folder not found" }, { status: 404 });
        }

        const targetFolderIdValue = targetFolder && typeof targetFolder.id === "string" ? targetFolder.id : null;
        const nameSegment =
            sanitizePathSegment(body.name || artifact.originalFilename || artifact.title || artifact.id);
        const parentPath = targetFolder && typeof targetFolder.path === "string" ? targetFolder.path : null;
        const newLogicalPath = buildChildPath(parentPath, nameSegment);
        const currentLogicalPath = deriveArtifactLogicalPath(artifact, companyId);
        if (newLogicalPath === currentLogicalPath && artifact.folderId === targetFolderIdValue) {
            return NextResponse.json({ message: "Artifact already in target location" });
        }

        const { uploadResult } = await relocateArtifactBlob({
            companyId,
            artifact,
            nextLogicalPath: newLogicalPath,
        });

        const [updatedArtifact] = await db.update(artifacts).set({
            folderId: targetFolderIdValue,
            path: newLogicalPath,
            storageKey: uploadResult?.storageKey ?? artifact.storageKey,
            storageUrl: uploadResult?.storageUrl ?? artifact.storageUrl,
            sizeBytes: uploadResult?.sizeBytes ?? artifact.sizeBytes,
            sha256: uploadResult?.checksum ?? artifact.sha256,
            contentType: uploadResult?.contentType ?? artifact.contentType,
            originalFilename: body.name || artifact.originalFilename,
            updatedAt: new Date(),
        }).where(and(
            eq(artifacts.id, artifact.id),
            eq(artifacts.companyId, companyId),
        )).returning();

        await logAudit(companyId, "agent", null, "move_artifact", "artifact", artifactIdValue, {
            fromPath: currentLogicalPath,
            toPath: newLogicalPath,
            folderId: targetFolderIdValue,
        });

        return NextResponse.json({ artifact: updatedArtifact });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to move artifact";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
