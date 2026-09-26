import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { storageAdapter } from "@/lib/storage";

/** Verify the bytes behind an artifact record without returning those bytes. */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const companyId = auth.companyToken!.companyId;
    const { id } = await context.params;
    const [artifact] = await db.select().from(artifacts).where(and(
        eq(artifacts.id, id), eq(artifacts.companyId, companyId), isNull(artifacts.deletedAt),
    )).limit(1);
    if (!artifact) return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
    if (!artifact.storageKey || !artifact.path) {
        return NextResponse.json({ ok: false, artifactId: artifact.id, error: "Artifact has no file-backed storage" }, { status: 409 });
    }

    try {
        const blob = await storageAdapter.download({ companyId, logicalPath: artifact.path });
        const sha256 = createHash("sha256").update(blob.buffer).digest("hex").toUpperCase();
        const sizeMatches = blob.sizeBytes === artifact.sizeBytes;
        const checksumMatches = sha256 === artifact.sha256.toUpperCase();
        return NextResponse.json({
            ok: sizeMatches && checksumMatches,
            artifactId: artifact.id,
            sizeBytes: blob.sizeBytes,
            sha256,
            expectedSizeBytes: artifact.sizeBytes,
            expectedSha256: artifact.sha256,
            error: sizeMatches && checksumMatches ? null : "Stored bytes do not match the artifact record",
        }, { status: sizeMatches && checksumMatches ? 200 : 409 });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        return NextResponse.json({
            ok: false,
            artifactId: artifact.id,
            error: code === "ENOENT" ? "Artifact blob is missing" : "Unable to read artifact blob",
        }, { status: code === "ENOENT" ? 409 : 500 });
    }
}
