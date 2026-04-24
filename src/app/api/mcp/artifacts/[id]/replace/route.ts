import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, logAudit } from "@/lib/mcp";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { storageAdapter } from "@/lib/storage";
import { findActiveFolder } from "@/lib/artifact-folders";
import { deriveArtifactLogicalPath, buildChildPath, sanitizePathSegment } from "@/lib/path-utils";
import { getFormStringValue, parseJsonMetadata } from "@/lib/form-utils";
import { ensureArtifactStorageSchema } from "@/lib/artifact-schema";
import {
    ArtifactFileTooLargeError,
    ArtifactStorageQuotaError,
    assertArtifactIngressAllowed,
    buildArtifactFileTooLargeErrorResponse,
    buildArtifactQuotaErrorResponse,
} from "@/lib/artifact-quota";

export async function PATCH(req: NextRequest, context: RouteContext<"/api/mcp/artifacts/[id]/replace">) {
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
        const form = await req.formData();
        const fileEntry = form.get("file");
        if (!(fileEntry instanceof File)) {
            return NextResponse.json({ error: "File field is required" }, { status: 400 });
        }

        const folderId = getFormStringValue(form, "folderId");
        const folder = folderId ? await findActiveFolder(companyId, folderId) : null;
        if (folderId && !folder) {
            return NextResponse.json({ error: "Folder not found" }, { status: 404 });
        }

        const nameSegment =
            sanitizePathSegment(
                getFormStringValue(form, "name") ||
                    artifact.originalFilename ||
                    artifact.title ||
                    fileEntry.name ||
                    artifact.id
            );
        const targetFolderIdValue = folder && typeof folder.id === "string" ? folder.id : null;
        const parentPath = folder && typeof folder.path === "string" ? folder.path : null;
        const newLogicalPath = buildChildPath(parentPath, nameSegment);
        const currentLogicalPath = deriveArtifactLogicalPath(artifact, companyId);

        const contentType =
            getFormStringValue(form, "contentType") ||
            fileEntry.type ||
            (typeof artifact.contentType === "string" ? artifact.contentType : undefined) ||
            "application/octet-stream";

        await assertArtifactIngressAllowed({
            companyId,
            incomingSizeBytes: fileEntry.size,
            replacingArtifactSizeBytes: artifact.sizeBytes,
        });
        const buffer = Buffer.from(await fileEntry.arrayBuffer());
        let uploadCompleted = false;

        try {
            const uploadResult = await storageAdapter.upload({
                companyId,
                logicalPath: newLogicalPath,
                data: buffer,
                contentType,
            });
            uploadCompleted = true;

            const metadataJson = parseJsonMetadata(form.get("metadataJson"));

            const [updatedArtifact] = await db.update(artifacts).set({
                folderId: targetFolderIdValue,
                path: newLogicalPath,
                storageKey: uploadResult.storageKey,
                storageUrl: uploadResult.storageUrl,
                sizeBytes: uploadResult.sizeBytes,
                sha256: uploadResult.checksum,
                contentType: uploadResult.contentType,
                originalFilename: nameSegment,
                title: getFormStringValue(form, "title") || artifact.title,
                metadataJson: Object.keys(metadataJson).length ? metadataJson : artifact.metadataJson,
                updatedAt: new Date(),
            }).where(and(
                eq(artifacts.id, artifact.id),
                eq(artifacts.companyId, companyId),
            )).returning();

            if (newLogicalPath !== currentLogicalPath) {
                try {
                    await storageAdapter.delete({
                        companyId,
                        logicalPath: currentLogicalPath,
                    });
                } catch (cleanupError) {
                    console.warn("Unable to purge previous MCP artifact blob after replace:", cleanupError);
                }
            }

            await logAudit(companyId, "agent", null, "replace_artifact", "artifact", artifactIdValue, {
                path: newLogicalPath,
                folderId: targetFolderIdValue,
            });

            return NextResponse.json({ artifact: updatedArtifact });
        } catch (error) {
            if (uploadCompleted && newLogicalPath !== currentLogicalPath) {
                try {
                    await storageAdapter.delete({ companyId, logicalPath: newLogicalPath });
                } catch (cleanupError) {
                    console.warn("Unable to clean up failed MCP artifact replacement:", cleanupError);
                }
            }
            throw error;
        }
    } catch (error) {
        if (error instanceof ArtifactFileTooLargeError) {
            return NextResponse.json(buildArtifactFileTooLargeErrorResponse(error), { status: 413 });
        }
        if (error instanceof ArtifactStorageQuotaError) {
            return NextResponse.json(buildArtifactQuotaErrorResponse(error), { status: 413 });
        }
        const message = error instanceof Error ? error.message : "Unable to replace artifact";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
