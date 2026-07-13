import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { storageAdapter } from "@/lib/storage";

export async function GET(req: NextRequest, context: RouteContext<"/api/mcp/artifacts/[id]/download">) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: artifactId } = await context.params;
    const [artifact] = await db.select().from(artifacts).where(and(
        eq(artifacts.id, artifactId),
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
        const artifactPath = typeof artifact.path === "string" ? artifact.path : null;
        const storageKey = typeof artifact.storageKey === "string" ? artifact.storageKey : "";
        const logicalPath = artifactPath || extractLogicalPath(storageKey, companyId);
        const download = await storageAdapter.download({
            companyId,
            logicalPath,
        });

        const filename =
            (typeof artifact.originalFilename === "string" && artifact.originalFilename) ||
            (typeof artifact.title === "string" && artifact.title) ||
            (artifact.id as string);
        const contentTypeValue =
            (typeof artifact.contentType === "string" && artifact.contentType) ||
            "application/octet-stream";
        const headers = new Headers({
            "Content-Type": contentTypeValue,
            "Content-Length": download.sizeBytes.toString(),
            "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        });

        const responseBody = new Uint8Array(download.buffer);
        return new NextResponse(responseBody, { headers });
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
