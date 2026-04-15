import { db } from "@/db";
import { artifacts, companyMembers } from "@/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

export const BETA_STORAGE_BYTES_PER_MEMBER = 1024 * 1024 * 1024;

export class ArtifactStorageQuotaError extends Error {
    readonly quotaBytes: number;
    readonly usedBytes: number;
    readonly attemptedIncreaseBytes: number;
    readonly memberCount: number;

    constructor(params: {
        quotaBytes: number;
        usedBytes: number;
        attemptedIncreaseBytes: number;
        memberCount: number;
    }) {
        super("Artifact storage quota exceeded");
        this.name = "ArtifactStorageQuotaError";
        this.quotaBytes = params.quotaBytes;
        this.usedBytes = params.usedBytes;
        this.attemptedIncreaseBytes = params.attemptedIncreaseBytes;
        this.memberCount = params.memberCount;
    }
}

export async function getArtifactStorageQuotaSnapshot(companyId: string) {
    const [{ memberCount }] = await db
        .select({ memberCount: sql<number>`count(*)` })
        .from(companyMembers)
        .where(eq(companyMembers.companyId, companyId));

    const effectiveMemberCount = Math.max(Number(memberCount) || 0, 1);

    const [{ usedBytes }] = await db
        .select({ usedBytes: sql<number>`coalesce(sum(${artifacts.sizeBytes}), 0)` })
        .from(artifacts)
        .where(
            and(
                eq(artifacts.companyId, companyId),
                eq(artifacts.storageProvider, "bunny"),
                isNull(artifacts.deletedAt),
            ),
        );

    const normalizedUsedBytes = Number(usedBytes) || 0;
    const quotaBytes = effectiveMemberCount * BETA_STORAGE_BYTES_PER_MEMBER;

    return {
        memberCount: effectiveMemberCount,
        quotaBytes,
        usedBytes: normalizedUsedBytes,
        remainingBytes: Math.max(0, quotaBytes - normalizedUsedBytes),
    };
}

export async function assertCanStoreArtifactBytes(params: {
    companyId: string;
    incomingSizeBytes: number;
    replacingArtifactSizeBytes?: number | null;
}) {
    const incomingSizeBytes = Math.max(0, params.incomingSizeBytes);
    const replacingArtifactSizeBytes = Math.max(0, params.replacingArtifactSizeBytes ?? 0);
    const attemptedIncreaseBytes = Math.max(0, incomingSizeBytes - replacingArtifactSizeBytes);

    if (attemptedIncreaseBytes === 0) {
        return getArtifactStorageQuotaSnapshot(params.companyId);
    }

    const snapshot = await getArtifactStorageQuotaSnapshot(params.companyId);
    if (snapshot.usedBytes + attemptedIncreaseBytes > snapshot.quotaBytes) {
        throw new ArtifactStorageQuotaError({
            quotaBytes: snapshot.quotaBytes,
            usedBytes: snapshot.usedBytes,
            attemptedIncreaseBytes,
            memberCount: snapshot.memberCount,
        });
    }

    return snapshot;
}

export function buildArtifactQuotaErrorResponse(error: ArtifactStorageQuotaError) {
    return {
        error: "Artifact storage quota exceeded",
        details: {
            quotaBytes: error.quotaBytes,
            usedBytes: error.usedBytes,
            attemptedIncreaseBytes: error.attemptedIncreaseBytes,
            memberCount: error.memberCount,
        },
    };
}
