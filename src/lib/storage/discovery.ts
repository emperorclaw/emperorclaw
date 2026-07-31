import { promises as fs } from "node:fs";
import path from "node:path";
import { getLocalStorageRoot } from "./local";
import { sanitizeLogicalPath } from "./path-sanitizer";

export type DiscoveredStorageEntry = {
    name: string;
    logicalPath: string;
    entryType: "file" | "folder";
    sizeBytes: number | null;
    modifiedAt: string;
    contentType: string | null;
};

export function isStorageDiscoveryEnabled() {
    if ((process.env.STORAGE_BACKEND || "local").toLowerCase() !== "local") return false;
    return ["1", "true", "yes", "on"].includes(
        (process.env.STORAGE_DISCOVERY_ENABLED || process.env.DRIVE_SYNC_ENABLED || "").toLowerCase(),
    );
}

export async function discoverDirectStorageEntries(params: {
    companyId: string;
    folderPath?: string | null;
}): Promise<DiscoveredStorageEntry[]> {
    if (!isStorageDiscoveryEnabled()) return [];

    const basePath = path.resolve(getLocalStorageRoot(), "companies", params.companyId, "artifacts");
    const logicalFolder = params.folderPath ? sanitizeLogicalPath(params.folderPath) : "";
    const targetPath = path.resolve(basePath, logicalFolder);
    if (targetPath !== basePath && !targetPath.startsWith(basePath + path.sep)) {
        throw new Error("Storage discovery path escaped the company root");
    }

    let entries;
    try {
        entries = await fs.readdir(targetPath, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }

    const discovered = await Promise.all(entries
        .filter((entry) => !shouldIgnoreEntry(entry.name))
        .map(async (entry): Promise<DiscoveredStorageEntry | null> => {
            if (!entry.isFile() && !entry.isDirectory()) return null;
            const logicalPath = [logicalFolder, entry.name].filter(Boolean).join("/");
            const stat = await fs.stat(path.join(targetPath, entry.name));
            return {
                name: entry.name,
                logicalPath,
                entryType: entry.isDirectory() ? "folder" : "file",
                sizeBytes: entry.isFile() ? stat.size : null,
                modifiedAt: stat.mtime.toISOString(),
                contentType: entry.isFile() ? inferContentType(entry.name) : null,
            };
        }));

    return discovered.filter((entry): entry is DiscoveredStorageEntry => Boolean(entry));
}

function shouldIgnoreEntry(name: string) {
    const normalized = name.toLowerCase();
    return name.startsWith(".") ||
        name.startsWith("~$") ||
        normalized.endsWith(".partial") ||
        normalized.endsWith(".tmp") ||
        normalized === "desktop.ini" ||
        normalized === "thumbs.db";
}

function inferContentType(name: string) {
    const extension = path.extname(name).toLowerCase();
    const known: Record<string, string> = {
        ".csv": "text/csv",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".gif": "image/gif",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".json": "application/json",
        ".md": "text/markdown",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".ppt": "application/vnd.ms-powerpoint",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".txt": "text/plain",
        ".webp": "image/webp",
        ".xls": "application/vnd.ms-excel",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".zip": "application/zip",
    };
    return known[extension] || "application/octet-stream";
}
