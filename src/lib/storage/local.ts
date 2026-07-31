import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
    StorageAdapter,
    StorageDeleteParams,
    StorageDirectoryParams,
    StorageDownloadParams,
    StorageDownloadResult,
    StorageStatResult,
    StorageUploadParams,
    StorageUploadResult,
} from "./types";
import { sanitizeLogicalPath } from "./path-sanitizer";
import { enqueueDriveMirrorDeletion } from "./drive-deletion-queue";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export function getLocalStorageRoot(): string {
    return (process.env.STORAGE_LOCAL_DIR || "./.data/storage").replace(/\\/g, "/");
}

export class LocalStorageAdapter implements StorageAdapter {
    buildStorageKey(companyId: string, logicalPath: string): string {
        const normalized = sanitizeLogicalPath(logicalPath);
        return `companies/${companyId}/artifacts/${normalized}`;
    }

    getDownloadUrl(params: StorageDownloadParams): string {
        const storageKey = this.buildStorageKey(params.companyId, params.logicalPath);
        const storageRoot = path.resolve(getLocalStorageRoot());
        const fullPath = path.resolve(storageRoot, storageKey);

        if (!fullPath.startsWith(storageRoot + path.sep) && fullPath !== storageRoot) {
            throw new Error("Path traversal detected in download URL resolution");
        }
        return `/api/ui/artifacts/${encodeURIComponent(storageKey)}/download`;
    }

    async upload(params: StorageUploadParams): Promise<StorageUploadResult> {
        const storageKey = this.buildStorageKey(params.companyId, params.logicalPath);
        const storageRoot = getLocalStorageRoot();
        const fullPath = path.resolve(storageRoot, storageKey);

        // Double-check containment after resolution
        if (!fullPath.startsWith(path.resolve(storageRoot) + path.sep) &&
            fullPath !== path.resolve(storageRoot)) {
            throw new Error("Path traversal rejected");
        }

        await fs.mkdir(path.dirname(fullPath), { recursive: true });

        const buffer = Buffer.isBuffer(params.data)
            ? params.data
            : Buffer.from(params.data);
        const checksum = (params.checksum || this.computeChecksum(buffer)).toUpperCase();
        const contentType = params.contentType?.trim() || DEFAULT_CONTENT_TYPE;

        await fs.writeFile(fullPath, buffer);

        const stat = await fs.stat(fullPath);

        return {
            storageKey,
            storageUrl: this.getDownloadUrl(params),
            sizeBytes: stat.size,
            contentType,
            checksum,
        };
    }

    async delete(params: StorageDeleteParams): Promise<void> {
        const storageKey = this.buildStorageKey(params.companyId, params.logicalPath);
        const storageRoot = getLocalStorageRoot();
        const fullPath = path.resolve(storageRoot, storageKey);

        if (!fullPath.startsWith(path.resolve(storageRoot) + path.sep) &&
            fullPath !== path.resolve(storageRoot)) {
            throw new Error("Path traversal rejected");
        }

        try {
            await fs.rm(fullPath);
        } catch (err: unknown) {
            // Already deleted is not an error
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code !== "ENOENT") throw err;
        }

        await enqueueDriveMirrorDeletion({
            companyId: params.companyId,
            logicalPath: params.logicalPath,
            entryType: "file",
        });
    }

    async download(params: StorageDownloadParams): Promise<StorageDownloadResult> {
        const storageKey = this.buildStorageKey(params.companyId, params.logicalPath);
        const storageRoot = getLocalStorageRoot();
        const fullPath = path.resolve(storageRoot, storageKey);

        if (!fullPath.startsWith(path.resolve(storageRoot) + path.sep) &&
            fullPath !== path.resolve(storageRoot)) {
            throw new Error("Path traversal rejected");
        }

        const buffer = await fs.readFile(fullPath);
        return {
            buffer,
            contentType: DEFAULT_CONTENT_TYPE,
            sizeBytes: buffer.length,
        };
    }

    async stat(params: StorageDownloadParams): Promise<StorageStatResult> {
        const storageKey = this.buildStorageKey(params.companyId, params.logicalPath);
        const storageRoot = getLocalStorageRoot();
        const fullPath = path.resolve(storageRoot, storageKey);

        if (!fullPath.startsWith(path.resolve(storageRoot) + path.sep) &&
            fullPath !== path.resolve(storageRoot)) {
            throw new Error("Path traversal rejected");
        }

        const fileStat = await fs.stat(fullPath);
        return {
            contentType: DEFAULT_CONTENT_TYPE,
            sizeBytes: fileStat.size,
        };
    }

    async ensureDirectory(params: StorageDirectoryParams): Promise<void> {
        const storageKey = this.buildStorageKey(params.companyId, params.logicalPath);
        const storageRoot = path.resolve(getLocalStorageRoot());
        const fullPath = path.resolve(storageRoot, storageKey);
        if (!fullPath.startsWith(storageRoot + path.sep)) {
            throw new Error("Path traversal rejected");
        }
        await fs.mkdir(fullPath, { recursive: true });
    }

    async removeDirectoryIfEmpty(params: StorageDirectoryParams): Promise<void> {
        const storageKey = this.buildStorageKey(params.companyId, params.logicalPath);
        const storageRoot = path.resolve(getLocalStorageRoot());
        const fullPath = path.resolve(storageRoot, storageKey);
        if (!fullPath.startsWith(storageRoot + path.sep)) {
            throw new Error("Path traversal rejected");
        }
        let removed = false;
        try {
            await fs.rmdir(fullPath);
            removed = true;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") removed = true;
            else if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
        }
        if (removed) {
            await enqueueDriveMirrorDeletion({
                companyId: params.companyId,
                logicalPath: params.logicalPath,
                entryType: "directory",
            });
        }
    }

    private computeChecksum(buffer: Buffer): string {
        return createHash("sha256").update(buffer).digest("hex");
    }
}
