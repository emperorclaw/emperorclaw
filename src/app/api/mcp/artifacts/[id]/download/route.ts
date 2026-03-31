import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { storageAdapter } from "@/lib/storage";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const [artifact] = await db.select().from(artifacts).where(and(
        eq(artifacts.id, params.id),
        eq(artifacts.companyId, companyId),
        isNull(artifacts.deletedAt),
    )).limit(1);

    if (!artifact) {
        return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
    }

    if (!artifact.storageKey) {
        return NextResponse.json({ error: "Artifact is not stored externally" }, { status: 400 });
    }

    try {
        const logicalPath = artifact.path || extractLogicalPath(artifact.storageKey || "", companyId);
        const download = await storageAdapter.download({
            companyId,
            logicalPath,
        });

        const filename = artifact.originalFilename || artifact.title || artifact.id;
        const headers = new Headers({
            "Content-Type": artifact.contentType || "application/octet-stream",
            "Content-Length": download.sizeBytes.toString(),
            "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        });

        return new NextResponse(download.buffer, { headers });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to download artifact";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

function extractLogicalPath(storageKey: string, companyId: string) {
    const prefix = `companies/${companyId}/artifacts/`;
    if (storageKey.startsWith(prefix)) {
        return storageKey.slice(prefix.length);
    }
    return storageKey;
}
