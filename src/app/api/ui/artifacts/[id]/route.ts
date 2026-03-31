import { NextRequest, NextResponse } from "next/server";
import { artifacts } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull, type InferModel } from "drizzle-orm";
import { prepareArtifactRecord } from "@/lib/artifacts";
import { requireCompanyFromSession } from "@/lib/company-session";

type ArtifactRecord = InferModel<typeof artifacts>;

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
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
        const artifactRecord = artifact as ArtifactRecord;

        const body = await req.json();
        const metadataJson = body.metadataJson ?? artifactRecord.metadataJson;
        const contentType = (body.contentType ?? artifactRecord.contentType) as string;
        const prepared = prepareArtifactRecord({
            kind: artifactRecord.kind as string,
            artifactClass: (body.artifactClass ?? artifactRecord.artifactClass) as string | null,
            importance: (body.importance ?? artifactRecord.importance) as string | null,
            title: (body.title ?? artifactRecord.title) as string | null,
            contentType,
            contentText: (artifactRecord.contentText as string | null) ?? null,
            storageUrl: (artifactRecord.storageUrl as string | null) ?? null,
            storageProvider: (artifactRecord.storageProvider as string | null) ?? null,
            storageKey: (artifactRecord.storageKey as string | null) ?? null,
            originalFilename: (artifactRecord.originalFilename as string | null) ?? null,
            sourceKind: (artifactRecord.sourceKind as string | null) ?? null,
            sourceRef: (artifactRecord.sourceRef as string | null) ?? null,
            sha256: artifactRecord.sha256 as string,
            sizeBytes: artifactRecord.sizeBytes as number,
            isCanonical: body.isCanonical ?? artifactRecord.isCanonical,
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
            eq(artifacts.id, artifactRecord.id),
            eq(artifacts.companyId, companyId),
        )).returning();

        return NextResponse.json({ artifact: updatedArtifact });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
    }
}
