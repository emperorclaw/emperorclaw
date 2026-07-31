import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../src/db";
import { artifactFolders, artifacts } from "../src/db/schema";

const apply = process.argv.includes("--apply");
const storageRoot = path.resolve(process.env.STORAGE_LOCAL_DIR || "./.data/storage");

async function exists(candidate: string) {
    try {
        await fs.access(candidate);
        return true;
    } catch {
        return false;
    }
}

function physicalPath(companyId: string, logicalPath: string) {
    const companyRoot = path.resolve(storageRoot, "companies", companyId, "artifacts");
    const resolved = path.resolve(companyRoot, logicalPath);
    if (!resolved.startsWith(companyRoot + path.sep)) {
        throw new Error(`Unsafe artifact path: ${logicalPath}`);
    }
    return resolved;
}

function logicalPathFromStorageKey(storageKey: string | null, companyId: string) {
    if (!storageKey) return null;
    const prefix = `companies/${companyId}/artifacts/`;
    return storageKey.startsWith(prefix) ? storageKey.slice(prefix.length) : null;
}

async function main() {
    if ((process.env.STORAGE_BACKEND || "local").toLowerCase() !== "local") {
        throw new Error("Storage reconciliation currently supports STORAGE_BACKEND=local only");
    }

    const artifactCompanies = await db.selectDistinct({ companyId: artifacts.companyId }).from(artifacts);
    const folderCompanies = await db.selectDistinct({ companyId: artifactFolders.companyId }).from(artifactFolders);
    const companyIds = Array.from(new Set([
        ...artifactCompanies.map((item) => item.companyId),
        ...folderCompanies.map((item) => item.companyId),
    ]));
    let healthy = 0;
    let missing = 0;
    let moves = 0;
    let directories = 0;

    for (const companyId of companyIds) {
        const folders = await db.select().from(artifactFolders).where(and(
            eq(artifactFolders.companyId, companyId),
            isNull(artifactFolders.deletedAt),
        ));
        for (const folder of folders) {
            const target = physicalPath(companyId, folder.path);
            if (!(await exists(target))) {
                directories += 1;
                console.log(`${apply ? "CREATE" : "WOULD CREATE"} directory ${folder.path}`);
                if (apply) await fs.mkdir(target, { recursive: true });
            }
        }

        const rows = await db.select().from(artifacts).where(and(
            eq(artifacts.companyId, companyId),
            isNull(artifacts.deletedAt),
        ));
        for (const artifact of rows) {
            const expectedLogical = artifact.path || logicalPathFromStorageKey(artifact.storageKey, companyId);
            if (!expectedLogical) {
                missing += 1;
                console.warn(`MISSING PATH artifact ${artifact.id}`);
                continue;
            }
            const expected = physicalPath(companyId, expectedLogical);
            if (await exists(expected)) {
                healthy += 1;
                continue;
            }

            const legacyLogical = logicalPathFromStorageKey(artifact.storageKey, companyId);
            const legacy = legacyLogical ? physicalPath(companyId, legacyLogical) : null;
            if (legacy && legacy !== expected && await exists(legacy)) {
                moves += 1;
                console.log(`${apply ? "MOVE" : "WOULD MOVE"} ${legacyLogical} -> ${expectedLogical}`);
                if (apply) {
                    await fs.mkdir(path.dirname(expected), { recursive: true });
                    if (await exists(expected)) throw new Error(`Refusing to overwrite ${expectedLogical}`);
                    await fs.rename(legacy, expected);
                    const storageKey = `companies/${companyId}/artifacts/${expectedLogical}`;
                    await db.update(artifacts).set({
                        storageKey,
                        storageUrl: `/api/ui/artifacts/${encodeURIComponent(storageKey)}/download`,
                        updatedAt: new Date(),
                    }).where(and(
                        eq(artifacts.id, artifact.id),
                        eq(artifacts.companyId, companyId),
                    ));
                }
                continue;
            }

            missing += 1;
            console.warn(`MISSING FILE artifact ${artifact.id}: ${expectedLogical}`);
        }
    }

    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", healthy, directories, moves, missing }, null, 2));
    if (!apply) console.log("No files were changed. Re-run with --apply after reviewing this report.");
    process.exitCode = missing > 0 ? 2 : 0;
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
