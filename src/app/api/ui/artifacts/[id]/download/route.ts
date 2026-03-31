import { NextRequest, NextResponse } from "next/server";
import { requireCompanyFromSession } from "@/lib/company-session";
import { artifacts } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { storageAdapter } from "@/lib/storage";
import { deriveArtifactLogicalPath } from "@/lib/path-utils";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
    try {
        const { companyId } = await requireCompanyFromSession();
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

        const logicalPath = deriveArtifactLogicalPath(artifact, companyId);
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
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
    }
}
