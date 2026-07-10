/**
 * Hardened logical-path sanitizer for storage adapters.
 *
 * Rejects or strips path-traversal attempts (`..`, `.`, null bytes,
 * leading/trailing slashes) before any storage operation.
 * Used by both BunnyStorageAdapter and LocalStorageAdapter.
 */

const MAX_SEGMENT_LENGTH = 255;
const MAX_PATH_LENGTH = 4096;

/**
 * Sanitize a logical path for storage operations.
 * Throws if the path contains traversal attempts or is otherwise unsafe.
 * Returns the cleaned, normalized path.
 */
export function sanitizeLogicalPath(raw: string): string {
    if (!raw || typeof raw !== "string") {
        throw new Error("Logical path must be a non-empty string");
    }

    // Reject null bytes (path truncation attacks)
    if (raw.includes("\0")) {
        throw new Error("Logical path contains null byte");
    }

    // Normalize backslashes to forward slashes
    let cleaned = raw.replace(/\\/g, "/");

    // Reject absolute paths
    if (cleaned.startsWith("/")) {
        throw new Error("Logical path must not be absolute");
    }

    // Reject traversal attempts via encoded sequences
    if (/%2e%2e|%2f|%5c/i.test(cleaned)) {
        throw new Error("Logical path contains encoded traversal sequences");
    }

    const segments = cleaned
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);

    if (segments.length === 0) {
        throw new Error("Logical path must include at least one segment");
    }

    const safe: string[] = [];
    for (const seg of segments) {
        // Reject traversal
        if (seg === ".." || seg === ".") {
            throw new Error(`Logical path contains disallowed segment: "${seg}"`);
        }

        // Reject empty or whitespace-only segments (double-slash, trailing slash)
        if (seg.length === 0) {
            throw new Error("Logical path contains empty segment");
        }

        // Reject overly long segments
        if (seg.length > MAX_SEGMENT_LENGTH) {
            throw new Error(`Logical path segment exceeds ${MAX_SEGMENT_LENGTH} characters`);
        }

        safe.push(seg);
    }

    const result = safe.join("/");

    if (result.length > MAX_PATH_LENGTH) {
        throw new Error(`Logical path exceeds ${MAX_PATH_LENGTH} characters`);
    }

    return result;
}

/**
 * Sanitize a single filename segment (e.g. from a file upload).
 * Strips slashes, backslashes, and traversal sequences.
 * Returns empty string if the result would be empty.
 */
export function sanitizeFilenameSegment(raw: string): string {
    if (!raw || typeof raw !== "string") return "";

    // Strip path separators and null bytes
    let cleaned = raw.replace(/[\\/]+/g, "-").replace(/\0/g, "").trim();

    // Strip leading dots that could be traversal
    cleaned = cleaned.replace(/^\.+/, "");

    // Collapse multiple dashes
    cleaned = cleaned.replace(/-{2,}/g, "-");

    // Remove leading/trailing dashes
    cleaned = cleaned.replace(/^-+/, "").replace(/-+$/, "");

    if (!cleaned || cleaned === "." || cleaned === "..") return "";

    if (cleaned.length > MAX_SEGMENT_LENGTH) {
        cleaned = cleaned.slice(0, MAX_SEGMENT_LENGTH);
    }

    return cleaned;
}
