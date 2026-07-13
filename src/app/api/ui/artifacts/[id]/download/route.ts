import { NextRequest, NextResponse } from "next/server";
import { requireCompanyFromSession } from "@/lib/company-session";
import { artifacts } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { storageAdapter } from "@/lib/storage";
import { deriveArtifactLogicalPath } from "@/lib/path-utils";

export async function GET(req: NextRequest, context: RouteContext<"/api/ui/artifacts/[id]/download">) {
    try {
        const { companyId, userId } = await requireCompanyFromSession();
        const { id: artifactId } = await context.params;
        const [artifact] = await db.select().from(artifacts).where(and(
            eq(artifacts.id, artifactId),
            eq(artifacts.companyId, companyId),
            isNull(artifacts.deletedAt),
        )).limit(1);

        if (!artifact) {
            return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
        }

        // Enforce visibility: "private" human uploads are only downloadable by
        // their uploader. Agent/system-created artifacts stay company-visible —
        // the operator must always be able to retrieve agent output.
        if (
            artifact.visibility === "private" &&
            artifact.createdByType === "human" &&
            artifact.createdById &&
            artifact.createdById !== userId
        ) {
            return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
        }

        if (!artifact.storageKey) {
            return NextResponse.json({ error: "Artifact is not stored externally" }, { status: 400 });
        }

        const logicalPath = deriveArtifactLogicalPath(artifact, companyId);
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

        // Only allow inline disposition for safe browser-renderable types.
        // Force attachment for everything else to prevent stored-XSS.
        const SAFE_INLINE_TYPES = new Set([
            "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
            "application/pdf", "text/plain", "text/csv", "text/markdown",
        ]);
        const disposition = req.nextUrl.searchParams.get("disposition") === "inline" &&
            SAFE_INLINE_TYPES.has(contentTypeValue)
            ? "inline"
            : "attachment";

        const headers = new Headers({
            "Content-Type": contentTypeValue,
            "Content-Length": download.sizeBytes.toString(),
            "Content-Disposition": `${disposition}; filename="${encodeURIComponent(filename)}"`,
            "X-Content-Type-Options": "nosniff",
        });

        const responseBody = new Uint8Array(download.buffer);
        return new NextResponse(responseBody, { headers });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to download artifact";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
    }
}
