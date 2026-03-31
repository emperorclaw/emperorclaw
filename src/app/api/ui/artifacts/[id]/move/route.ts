import { NextRequest, NextResponse } from "next/server";
import { requireCompanyFromSession } from "@/lib/company-session";
import { artifacts } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { findActiveFolder } from "@/lib/artifact-folders";
import { deriveArtifactLogicalPath, buildChildPath, sanitizePathSegment } from "@/lib/path-utils";
import { relocateArtifactBlob } from "@/lib/artifact-storage";
import { ensureArtifactStorageSchema } from "@/lib/artifact-schema";

export async function PATCH(req: NextRequest, context: RouteContext<"/api/ui/artifacts/[id]/move">) {
    try {
        const { companyId } = await requireCompanyFromSession();
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

        const body = await req.json();
        const targetFolderId = body.folderId || null;
        const targetFolder = targetFolderId ? await findActiveFolder(companyId, targetFolderId) : null;
        if (targetFolderId && !targetFolder) {
            return NextResponse.json({ error: "Destination folder not found" }, { status: 404 });
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
            originalFilename: nameSegment,
            updatedAt: new Date(),
        }).where(and(
            eq(artifacts.id, artifact.id),
            eq(artifacts.companyId, companyId),
        )).returning();

        return NextResponse.json({ artifact: updatedArtifact });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to move artifact";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
    }
}
