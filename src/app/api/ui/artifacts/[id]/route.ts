import { NextRequest, NextResponse } from "next/server";
import { artifacts } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { prepareArtifactRecord } from "@/lib/artifacts";
import { requireCompanyFromSession } from "@/lib/company-session";

export async function PATCH(
    req: NextRequest,
    { params }: { params: { id: string } }
) {
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

        const body = await req.json();
        const metadataJson = body.metadataJson ?? artifact.metadataJson;
        const contentType = body.contentType || artifact.contentType;
        const prepared = prepareArtifactRecord({
            kind: artifact.kind,
            artifactClass: body.artifactClass ?? artifact.artifactClass,
            importance: body.importance ?? artifact.importance,
            title: body.title ?? artifact.title,
            contentType,
            contentText: artifact.contentText,
            storageUrl: artifact.storageUrl,
            storageProvider: artifact.storageProvider,
            storageKey: artifact.storageKey,
            originalFilename: artifact.originalFilename,
            sourceKind: artifact.sourceKind,
            sourceRef: artifact.sourceRef,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
            isCanonical: body.isCanonical ?? artifact.isCanonical,
            metadataJson,
        });

        const [updatedArtifact] = await db.update(artifacts).set({
            title: prepared.title,
            artifactClass: prepared.artifactClass,
            importance: prepared.importance,
            contentType: prepared.contentType,
            metadataJson: prepared.metadataJson,
            isCanonical: prepared.isCanonical,
            promotedAt: prepared.promotedAt,
            updatedAt: new Date(),
        }).where(and(
            eq(artifacts.id, artifact.id),
            eq(artifacts.companyId, companyId),
        )).returning();

        return NextResponse.json({ artifact: updatedArtifact });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
    }
}
