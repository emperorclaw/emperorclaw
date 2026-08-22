export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getCompanyId, getUserId } from "@/lib/auth";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { storageAdapter, getStorageProviderName } from "@/lib/storage";
import { prepareArtifactRecord } from "@/lib/artifacts";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

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
        const rawType = (file.type || "audio/webm").toLowerCase();
        const contentType = rawType.split(";")[0].trim();

        // Accept any audio/* MIME type — browser defaults vary (webm, ogg, mp4, etc.)
        if (!contentType.startsWith("audio/")) {
            return NextResponse.json({ error: "Unsupported audio type — only audio files are accepted" }, { status: 415 });
        }
        if (file.size > MAX_BYTES) {
            return NextResponse.json({ error: "Voice message too large (max 10 MB)" }, { status: 413 });
        }

        // Derive extension from MIME type — Map of audio/* subtypes to file extensions
        const SUBTYPE_EXT: Record<string, string> = {
            "webm": "webm",
            "ogg": "ogg",
            "mp4": "m4a",
            "mpeg": "mp3",
            "mpga": "mp3",
            "wav": "wav",
            "x-wav": "wav",
            "x-m4a": "m4a",
            "aac": "aac",
            "flac": "flac",
        };
        const subtype = contentType.replace("audio/", "");
        const ext = SUBTYPE_EXT[subtype] ?? "webm";
        const filename = `voice-${Date.now()}.${ext}`;
        const logicalPath = `voice-messages/${randomUUID()}.${ext}`;
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

            // Register as a real artifact — without this row neither the UI
            // download route (/api/ui/artifacts/[id]) nor the agent-facing MCP
            // one (/api/mcp/artifacts/[id]) can resolve the file, and it never
            // shows up in the artifact list the agent browses.
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
                metadataJson: { source: "voice-message" },
            });

            const [artifact] = await db.insert(artifacts).values({
                companyId,
                path: logicalPath,
                ...preparedArtifact,
                createdByType: "human",
                createdById: userId,
                visibility: "company",
                sourceKind: "voice-message",
            }).returning();

            return NextResponse.json({
                id: artifact.id as string,
                name: filename,
                contentType: uploadResult.contentType,
                sizeBytes: uploadResult.sizeBytes,
            }, { status: 201 });
        } catch (error) {
            if (uploadCompleted) {
                try {
                    await storageAdapter.delete({ companyId, logicalPath });
                } catch (cleanupError) {
                    console.warn("Unable to clean up failed voice upload:", cleanupError);
                }
            }
            throw error;
        }
    } catch (err) {
        console.error("Voice upload error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
