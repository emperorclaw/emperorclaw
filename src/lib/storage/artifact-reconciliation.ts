import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { getLocalStorageRoot } from "./local";
import { sanitizeLogicalPath } from "./path-sanitizer";

type ReconcileCandidate = {
    id: string;
    path: string | null;
    sizeBytes: number;
    sha256: string;
    updatedAt: Date;
};

/**
 * Refresh database checksums after a shared-volume mirror replaces tracked
 * file content. Structural changes remain authoritative in Emperor.
 */
export async function reconcileTrackedLocalArtifacts(
    companyId: string,
    candidates: ReconcileCandidate[],
) {
    if ((process.env.STORAGE_BACKEND || "local").toLowerCase() !== "local") return new Map();

    const changed = new Map<string, { sizeBytes: number; sha256: string; updatedAt: Date }>();
    const companyRoot = path.resolve(getLocalStorageRoot(), "companies", companyId, "artifacts");

    for (const candidate of candidates) {
        if (!candidate.path) continue;
        const logicalPath = sanitizeLogicalPath(candidate.path);
        const fullPath = path.resolve(companyRoot, logicalPath);
        if (!fullPath.startsWith(companyRoot + path.sep)) continue;

        let stat;
        try {
            stat = await fs.stat(fullPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
        }
        if (!stat.isFile()) continue;

        // A one-second tolerance avoids re-hashing files just written by the
        // application in the same request that created the database record.
        const contentMayHaveChanged =
            stat.size !== candidate.sizeBytes ||
            stat.mtimeMs > candidate.updatedAt.getTime() + 1000;
        if (!contentMayHaveChanged) continue;

        const buffer = await fs.readFile(fullPath);
        const sha256 = createHash("sha256").update(buffer).digest("hex").toUpperCase();
        if (sha256 === candidate.sha256.toUpperCase() && stat.size === candidate.sizeBytes) continue;

        const updatedAt = new Date();
        await db.update(artifacts).set({
            sizeBytes: stat.size,
            sha256,
            updatedAt,
        }).where(and(
            eq(artifacts.id, candidate.id),
            eq(artifacts.companyId, companyId),
        ));
        changed.set(candidate.id, { sizeBytes: stat.size, sha256, updatedAt });
    }

    return changed;
}
