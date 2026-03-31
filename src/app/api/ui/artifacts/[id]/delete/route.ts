import { NextRequest, NextResponse } from "next/server";
import { requireCompanyFromSession } from "@/lib/company-session";
import { artifacts } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { storageAdapter } from "@/lib/storage";
import { deriveArtifactLogicalPath } from "@/lib/path-utils";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { companyId } = await requireCompanyFromSession();
    const { id: artifactId } = await params;
    const [artifact] = await db.select().from(artifacts).where(and(
        eq(artifacts.id, artifactId),
            eq(artifacts.companyId, companyId),
            isNull(artifacts.deletedAt),
        )).limit(1);

        if (!artifact) {
            return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
        }

        const purge = req.nextUrl.searchParams.get("purgeStorage") !== "false";
        if (purge && artifact.storageKey) {
            const logicalPath = deriveArtifactLogicalPath(artifact, companyId);
            try {
                await storageAdapter.delete({ companyId, logicalPath });
            } catch (err) {
                console.warn("Unable to delete blob for artifact:", err);
            }
        }

        const now = new Date();
        await db.update(artifacts).set({ deletedAt: now }).where(and(
            eq(artifacts.id, artifact.id),
            eq(artifacts.companyId, companyId),
        ));

        return NextResponse.json({ success: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to delete artifact";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
    }
}
