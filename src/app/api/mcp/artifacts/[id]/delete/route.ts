import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, logAudit } from "@/lib/mcp";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { storageAdapter } from "@/lib/storage";
import { deriveArtifactLogicalPath } from "@/lib/path-utils";
import { ensureArtifactStorageSchema } from "@/lib/artifact-schema";

export async function DELETE(req: NextRequest, context: RouteContext<"/api/mcp/artifacts/[id]/delete">) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    await ensureArtifactStorageSchema();
    const { id: artifactId } = await context.params;
    const [artifact] = await db.select().from(artifacts).where(and(
        eq(artifacts.id, artifactId),
        eq(artifacts.companyId, companyId),
        isNull(artifacts.deletedAt),
    )).limit(1);

    if (!artifact) {
        return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
    }

    const artifactIdValue = artifact.id as string;
    const deleteContent = req.nextUrl.searchParams.get("purgeStorage") !== "false";
    if (deleteContent && artifact.storageKey) {
        const logicalPath = deriveArtifactLogicalPath(artifact, companyId);
        try {
            await storageAdapter.delete({ companyId, logicalPath });
        } catch (error) {
            console.warn("Unable to purge artifact from storage:", error);
        }
    }

    const now = new Date();
    await db.update(artifacts).set({
        deletedAt: now,
    }).where(and(
        eq(artifacts.id, artifactIdValue),
        eq(artifacts.companyId, companyId),
    ));

    await logAudit(companyId, "agent", null, "delete_artifact", "artifact", artifactIdValue, {
            purgeStorage: deleteContent,
        });

    return NextResponse.json({ success: true });
}
