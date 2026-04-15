import { createHash } from "crypto";
import {
    ARTIFACT_CLASS_OPTIONS,
    ARTIFACT_IMPORTANCE_OPTIONS,
    DEFAULT_ARTIFACT_CLASS,
    DEFAULT_ARTIFACT_IMPORTANCE,
} from "@/lib/artifact-taxonomy";

const ALLOWED_ARTIFACT_CLASSES = new Set<string>(ARTIFACT_CLASS_OPTIONS.map((option) => option.value));

const ALLOWED_IMPORTANCE = new Set<string>(ARTIFACT_IMPORTANCE_OPTIONS.map((option) => option.value));

export function normalizeArtifactClass(value?: string | null) {
    const normalized = (value || DEFAULT_ARTIFACT_CLASS).trim().toLowerCase();
    if (!ALLOWED_ARTIFACT_CLASSES.has(normalized)) {
        throw new Error(`Unsupported artifactClass: ${value}`);
    }
    return normalized;
}

export function normalizeArtifactImportance(value?: string | null, artifactClass?: string | null) {
    const fallback = artifactClass === "deliverable" || artifactClass === "export_bundle"
        ? "record"
        : DEFAULT_ARTIFACT_IMPORTANCE;
    const normalized = (value || fallback).trim().toLowerCase();
    if (!ALLOWED_IMPORTANCE.has(normalized)) {
        throw new Error(`Unsupported importance: ${value}`);
    }
    return normalized;
}

export function deriveArtifactHash(input: {
    contentText?: string | null;
    storageUrl?: string | null;
    sha256?: string | null;
}) {
    if (input.sha256) return input.sha256;
    if (input.contentText != null) {
        return createHash("sha256").update(input.contentText, "utf8").digest("hex");
    }
    if (input.storageUrl) {
        throw new Error("sha256 is required when storing a remote artifact by reference");
    }
    throw new Error("Either contentText or storageUrl is required");
}

export function deriveArtifactSize(input: {
    sizeBytes?: number | null;
    contentText?: string | null;
    storageUrl?: string | null;
}) {
    if (typeof input.sizeBytes === "number" && Number.isFinite(input.sizeBytes) && input.sizeBytes >= 0) {
        return input.sizeBytes;
    }
    if (input.contentText != null) {
        return Buffer.byteLength(input.contentText, "utf8");
    }
    if (input.storageUrl) {
        throw new Error("sizeBytes is required when storing a remote artifact by reference");
    }
    return 0;
}

export function sanitizeArtifact<T extends { metadataJson?: unknown }>(artifact: T) {
    return {
        ...artifact,
        metadataJson: artifact.metadataJson || {},
    };
}

export function sanitizeArtifactClientPayload<T extends Record<string, unknown>>(artifact: T): Omit<T, "storageUrl" | "storageKey"> {
    const { storageUrl, storageKey, ...rest } = artifact as T & {
        storageUrl?: unknown;
        storageKey?: unknown;
    };
    void storageUrl;
    void storageKey;
    return rest;
}

export type PreparedArtifactRecord = {
    title: string | null;
    kind: string;
    artifactClass: string;
    importance: string;
    contentType: string;
    contentText: string | null;
    storageUrl: string | null;
    storageProvider: string | null;
    storageKey: string | null;
    originalFilename: string | null;
    sourceKind: string | null;
    sourceRef: string | null;
    sha256: string;
    sizeBytes: number;
    isCanonical: boolean;
    promotedAt: Date | null;
    metadataJson: Record<string, unknown>;
};

export function prepareArtifactRecord(input: {
    kind: string;
    artifactClass?: string | null;
    importance?: string | null;
    title?: string | null;
    contentType: string;
    contentText?: string | null;
    storageUrl?: string | null;
    storageProvider?: string | null;
    storageKey?: string | null;
    originalFilename?: string | null;
    sourceKind?: string | null;
    sourceRef?: string | null;
    sha256?: string | null;
    sizeBytes?: number | null;
    isCanonical?: boolean | null;
    metadataJson?: Record<string, unknown> | null;
}): PreparedArtifactRecord {
    const artifactClass = normalizeArtifactClass(input.artifactClass);
    const importance = normalizeArtifactImportance(input.importance, artifactClass);
    const sha256 = deriveArtifactHash({
        contentText: input.contentText || null,
        storageUrl: input.storageUrl || null,
        sha256: input.sha256 || null,
    });
    const sizeBytes = deriveArtifactSize({
        sizeBytes: input.sizeBytes,
        contentText: input.contentText || null,
        storageUrl: input.storageUrl || null,
    });
    const canonical = Boolean(input.isCanonical || importance === "canonical");

    return {
        title: input.title || null,
        kind: input.kind,
        artifactClass,
        importance: canonical ? "canonical" : importance,
        contentType: input.contentType,
        contentText: input.contentText || null,
        storageUrl: input.storageUrl || null,
        storageProvider: input.storageProvider || null,
        storageKey: input.storageKey || null,
        originalFilename: input.originalFilename || null,
        sourceKind: input.sourceKind || null,
        sourceRef: input.sourceRef || null,
        sha256,
        sizeBytes,
        isCanonical: canonical,
        promotedAt: canonical ? new Date() : null,
        metadataJson: input.metadataJson || {},
    };
}
