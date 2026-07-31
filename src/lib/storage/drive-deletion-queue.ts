import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sanitizeLogicalPath } from "./path-sanitizer";

type DriveDeletionType = "file" | "directory";

function isEnabled(value: string | undefined) {
    return ["1", "true", "yes", "on"].includes((value || "").toLowerCase());
}

export function isDriveDeletionQueueEnabled() {
    return (process.env.STORAGE_BACKEND || "local").toLowerCase() === "local" &&
        isEnabled(process.env.DRIVE_SYNC_ENABLED);
}

/**
 * Persist an Emperor-originated deletion for the rclone sidecar. The marker is
 * written inside the shared storage volume, so it survives app and sidecar
 * restarts without giving the application access to Google credentials.
 */
export async function enqueueDriveMirrorDeletion(input: {
    companyId: string;
    logicalPath: string;
    entryType: DriveDeletionType;
}) {
    if (!isDriveDeletionQueueEnabled()) return;
    if (!input.companyId || /[\\/\r\n]/.test(input.companyId)) {
        throw new Error("Invalid company id for Drive deletion queue");
    }

    const logicalPath = sanitizeLogicalPath(input.logicalPath);
    if (!logicalPath || /[\r\n]/.test(logicalPath)) {
        throw new Error("Invalid logical path for Drive deletion queue");
    }

    const queueKind = input.entryType === "directory" ? "directories" : "files";
    const storageRoot = (process.env.STORAGE_LOCAL_DIR || "./.data/storage").replace(/\\/g, "/");
    const queueRoot = path.resolve(storageRoot, ".drive-sync", "deletions", queueKind);
    const markerId = randomUUID();
    const markerPath = path.join(queueRoot, markerId);
    const temporaryPath = `${markerPath}.partial`;
    const remoteRelativePath = `${input.companyId}/artifacts/${logicalPath}`;

    await fs.mkdir(queueRoot, { recursive: true });
    await fs.writeFile(temporaryPath, `${remoteRelativePath}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, markerPath);
}
