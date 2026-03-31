import { NextRequest, NextResponse } from "next/server";
import { requireCompanyFromSession } from "@/lib/company-session";
import { artifacts } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { storageAdapter } from "@/lib/storage";
import { deriveArtifactLogicalPath } from "@/lib/path-utils";

export async function GET(req: NextRequest, context: RouteContext<"/api/ui/artifacts/[id]/download">) {
    try {
        const { companyId } = await requireCompanyFromSession();
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

        const logicalPath = deriveArtifactLogicalPath(artifact, companyId);
        const download = await storageAdapter.download({
            companyId,
            logicalPath,
        });

        const filename =
            (typeof artifact.originalFilename === "string" && artifact.originalFilename) ||
            (typeof artifact.title === "string" && artifact.title) ||
            (artifact.id as string);
        const disposition = req.nextUrl.searchParams.get("disposition") === "inline" ? "inline" : "attachment";
        const contentTypeValue =
            (typeof artifact.contentType === "string" && artifact.contentType) ||
            "application/octet-stream";
        const headers = new Headers({
            "Content-Type": contentTypeValue,
            "Content-Length": download.sizeBytes.toString(),
            "Content-Disposition": `${disposition}; filename="${encodeURIComponent(filename)}"`,
        });

        const responseBody = new Uint8Array(download.buffer);
        return new NextResponse(responseBody, { headers });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to download artifact";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
    }
}
