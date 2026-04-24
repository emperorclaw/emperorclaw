import { db } from "@/db";
import { artifacts, companyMembers } from "@/db/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";

export const BETA_STORAGE_BYTES_PER_MEMBER = 1024 * 1024 * 1024;
export const DEFAULT_MAX_ARTIFACT_FILE_BYTES = 100 * 1024 * 1024;

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

export class ArtifactFileTooLargeError extends Error {
    readonly attemptedBytes: number;
    readonly maxBytes: number;

    constructor(params: { attemptedBytes: number; maxBytes: number }) {
        super("Artifact file exceeds the maximum allowed upload size");
        this.name = "ArtifactFileTooLargeError";
        this.attemptedBytes = params.attemptedBytes;
        this.maxBytes = params.maxBytes;
    }
}

function getPositiveIntegerEnv(name: string): number | null {
    const raw = process.env[name];
    if (!raw) {
        return null;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getArtifactMaxFileBytes() {
    return (
        getPositiveIntegerEnv("EMPEROR_ARTIFACT_MAX_UPLOAD_BYTES") ||
        getPositiveIntegerEnv("ARTIFACT_MAX_UPLOAD_BYTES") ||
        DEFAULT_MAX_ARTIFACT_FILE_BYTES
    );
}

export function assertArtifactFileSizeWithinLimit(sizeBytes: number) {
    const attemptedBytes = Math.max(0, sizeBytes);
    const maxBytes = getArtifactMaxFileBytes();

    if (attemptedBytes > maxBytes) {
        throw new ArtifactFileTooLargeError({ attemptedBytes, maxBytes });
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
                isNotNull(artifacts.storageKey),
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

export async function assertArtifactIngressAllowed(params: {
    companyId: string;
    incomingSizeBytes: number;
    replacingArtifactSizeBytes?: number | null;
}) {
    assertArtifactFileSizeWithinLimit(params.incomingSizeBytes);
    return assertCanStoreArtifactBytes(params);
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

export function buildArtifactFileTooLargeErrorResponse(error: ArtifactFileTooLargeError) {
    return {
        error: "Artifact file exceeds the maximum allowed upload size",
        details: {
            attemptedBytes: error.attemptedBytes,
            maxBytes: error.maxBytes,
        },
    };
}
