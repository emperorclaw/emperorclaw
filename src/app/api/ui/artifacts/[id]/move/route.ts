import { NextRequest, NextResponse } from "next/server";
import { requireCompanyFromSession } from "@/lib/company-session";
import { artifacts } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { storageAdapter } from "@/lib/storage";
import { findActiveFolder } from "@/lib/artifact-folders";
import { deriveArtifactLogicalPath, buildChildPath, sanitizePathSegment } from "@/lib/path-utils";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
    try {
        const { companyId } = await requireCompanyFromSession();
        const [artifact] = await db.select().from(artifacts).where(and(
            eq(artifacts.id, params.id),
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

        const nameSegment =
            sanitizePathSegment(body.name || artifact.originalFilename || artifact.title || artifact.id);
        const newLogicalPath = buildChildPath(targetFolder?.path ?? null, nameSegment);
        const currentLogicalPath = deriveArtifactLogicalPath(artifact, companyId);
        if (newLogicalPath === currentLogicalPath && artifact.folderId === (targetFolder?.id ?? null)) {
            return NextResponse.json({ message: "Artifact already in target location" });
        }

        const download = await storageAdapter.download({
            companyId,
            logicalPath: currentLogicalPath,
        });

        const uploadResult = await storageAdapter.upload({
            companyId,
            logicalPath: newLogicalPath,
            data: download.buffer,
            contentType: artifact.contentType || download.contentType || "application/octet-stream",
        });

        await storageAdapter.delete({
            companyId,
            logicalPath: currentLogicalPath,
        });

        const [updatedArtifact] = await db.update(artifacts).set({
            folderId: targetFolder ? targetFolder.id : null,
            path: newLogicalPath,
            storageKey: uploadResult.storageKey,
            storageUrl: uploadResult.storageUrl,
            sizeBytes: uploadResult.sizeBytes,
            sha256: uploadResult.checksum,
            contentType: uploadResult.contentType,
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
