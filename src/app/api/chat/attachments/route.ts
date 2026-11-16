export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { storageAdapter, getStorageProviderName } from "@/lib/storage";
import { prepareArtifactRecord } from "@/lib/artifacts";
import { sanitizeFilenameSegment } from "@/lib/storage/path-sanitizer";
import { companyRouteAccess } from "@/lib/company-access";
import { buildChildPath } from "@/lib/path-utils";
import { ensureUserUploadsFolder } from "@/lib/artifact-folders";
import {
    ArtifactFileTooLargeError,
    ArtifactStorageQuotaError,
    assertArtifactIngressAllowed,
    buildArtifactFileTooLargeErrorResponse,
    buildArtifactQuotaErrorResponse,
} from "@/lib/artifact-quota";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Allowlisted content types for chat attachments. Rejecting by MIME keeps
 * executable/script/html payloads out of agent workspaces. The underlying
 * storage is company-scoped and only reachable via authed endpoints, so this
 * is defense-in-depth, not the only gate.
 */
const ALLOWED_MIME: ReadonlySet<string> = new Set([
    // Images
    "image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/tiff",
    // Documents
    "application/pdf",
    "text/plain", "text/markdown", "text/csv", "application/json", "application/xml",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    // Archives
    "application/zip", "application/x-tar", "application/gzip",
    // Audio / video
    "audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm", "audio/x-m4a", "audio/mp4", "audio/aac", "audio/flac",
    "video/mp4", "video/webm", "video/quicktime",
]);

export async function POST(req: NextRequest) {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const userId = access.ctx.userId;

    try {
        const form = await req.formData();
        const file = form.get("file");
        if (!(file instanceof File)) {
            return NextResponse.json({ error: "file field required" }, { status: 400 });
        }

        // Strip codec/params from MIME type (e.g. "audio/webm;codecs=opus" → "audio/webm")
        const rawType = (file.type || "application/octet-stream").toLowerCase();
        const contentType = rawType.split(";")[0].trim();

        if (!ALLOWED_MIME.has(contentType)) {
            return NextResponse.json({
                error: `Unsupported file type (${contentType || "unknown"}) — only documents, images, archives, audio and video are accepted`,
            }, { status: 415 });
        }
        if (file.size > MAX_BYTES) {
            return NextResponse.json({ error: "Attachment too large (max 25 MB)" }, { status: 413 });
        }

        await assertArtifactIngressAllowed({ companyId, incomingSizeBytes: file.size });

        // The uploader's own folder, uploads/<userId>: private to them (and
        // owners/admins); agents read it only through a message it is
        // attached to (lib/artifact-visibility.ts).
        const folder = await ensureUserUploadsFolder(companyId, userId);
        const filename = file.name || `attachment-${randomUUID()}`;
        const logicalPath = buildChildPath(folder.path, `${randomUUID()}-${sanitizeFilenameSegment(filename)}`);
        const buffer = Buffer.from(await file.arrayBuffer());

        let uploadCompleted = false;
        try {
            const uploadResult = await storageAdapter.upload({
                companyId,
                logicalPath,
                data: buffer,
                contentType,
            });
            uploadCompleted = true;

            const preparedArtifact = prepareArtifactRecord({
                kind: "file",
                title: filename,
                contentType: uploadResult.contentType,
                storageProvider: getStorageProviderName(),
                storageUrl: uploadResult.storageUrl,
                storageKey: uploadResult.storageKey,
                originalFilename: filename,
                sha256: uploadResult.checksum,
                sizeBytes: uploadResult.sizeBytes,
                metadataJson: { source: "chat-attachment" },
            });

            const [artifact] = await db.insert(artifacts).values({
                companyId,
                folderId: folder.id,
                path: logicalPath,
                ...preparedArtifact,
                createdByType: "human",
                createdById: userId,
                // Private: attaching it to a message shares it with the agents
                // who can read that message, not with the whole company.
                visibility: "private",
                sourceKind: "chat-attachment",
            }).returning();

            return NextResponse.json({
                id: artifact.id as string,
                name: filename,
                contentType: uploadResult.contentType,
                sizeBytes: uploadResult.sizeBytes,
                url: uploadResult.storageUrl,
            }, { status: 201 });
        } catch (error) {
            if (uploadCompleted) {
                try {
                    await storageAdapter.delete({ companyId, logicalPath });
                } catch (cleanupError) {
                    console.warn("Unable to clean up failed chat attachment upload:", cleanupError);
                }
            }
            throw error;
        }
    } catch (err) {
        if (err instanceof ArtifactFileTooLargeError) {
            return NextResponse.json(buildArtifactFileTooLargeErrorResponse(err), { status: 413 });
        }
        if (err instanceof ArtifactStorageQuotaError) {
            return NextResponse.json(buildArtifactQuotaErrorResponse(err), { status: 413 });
        }
        console.error("Chat attachment upload error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
