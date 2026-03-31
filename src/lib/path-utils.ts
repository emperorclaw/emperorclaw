export function sanitizePathSegment(value: unknown): string {
    if (typeof value !== "string") {
        return "";
    }
    return value.replace(/[\\/]+/g, "-").trim();
}

export function buildChildPath(parentPath: string | null, childSegment: string) {
    const segment = sanitizePathSegment(childSegment);
    if (!segment) {
        throw new Error("Path segment cannot be empty");
    }
    if (!parentPath) {
        return segment;
    }
    const trimmedParent = parentPath.replace(/\/+$/, "");
    return `${trimmedParent}/${segment}`;
}

export function extractLogicalPathFromStorageKey(storageKey: string | null, companyId: string) {
    if (!storageKey) {
        throw new Error("storageKey is required to derive logical path");
    }
    const prefix = `companies/${companyId}/artifacts/`;
    if (storageKey.startsWith(prefix)) {
        return storageKey.slice(prefix.length);
    }
    return storageKey.replace(/^companies\/[^/]+\/artifacts\//, "");
}

export function deriveArtifactLogicalPath(
    artifact: { path?: string | null; storageKey?: string | null },
    companyId: string
) {
    if (artifact.path) {
        return artifact.path;
    }
    return extractLogicalPathFromStorageKey(artifact.storageKey || "", companyId);
}
