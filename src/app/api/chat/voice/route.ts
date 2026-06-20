export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from "next/server";
import { getCompanyId } from "@/lib/auth";
import { storageAdapter } from "@/lib/storage";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
        const logicalPath = `voice-messages/${crypto.randomUUID()}.${ext}`;
        const buffer = Buffer.from(await file.arrayBuffer());

        const result = await storageAdapter.upload({
            companyId,
            logicalPath,
            data: buffer,
            contentType,
        });

        return NextResponse.json({ url: result.storageUrl });
    } catch (err) {
        console.error("Voice upload error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
