export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getCompanyId, getUserId } from "@/lib/auth";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { storageAdapter, getStorageProviderName } from "@/lib/storage";
import { prepareArtifactRecord } from "@/lib/artifacts";
import { sanitizeFilenameSegment } from "@/lib/storage/path-sanitizer";

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
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

        const filename = file.name || `attachment-${randomUUID()}`;
        const logicalPath = `chat-attachments/${randomUUID()}-${sanitizeFilenameSegment(filename)}`;
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
                path: logicalPath,
                ...preparedArtifact,
                createdByType: "human",
                createdById: userId,
                // Attaching to a message is the explicit consent to share it
                // with the company's agents — company-visible, not private.
                visibility: "company",
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
        console.error("Chat attachment upload error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
