export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from "next/server";
import { getCompanyId } from "@/lib/auth";
import { storageAdapter } from "@/lib/storage";

const ALLOWED_TYPES = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav"]);
const EXT_MAP: Record<string, string> = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
};
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

        const contentType = file.type || "audio/webm";
        if (!ALLOWED_TYPES.has(contentType)) {
            return NextResponse.json({ error: "Unsupported audio type" }, { status: 415 });
        }
        if (file.size > MAX_BYTES) {
            return NextResponse.json({ error: "Voice message too large (max 10 MB)" }, { status: 413 });
        }

        const ext = EXT_MAP[contentType] ?? "webm";
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
