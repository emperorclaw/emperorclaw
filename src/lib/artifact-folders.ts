import { db } from "@/db";
import { artifactFolders } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { buildChildPath, sanitizePathSegment } from "@/lib/path-utils";

export async function findActiveFolder(companyId: string, folderId: string) {
    const [folder] = await db.select().from(artifactFolders).where(and(
        eq(artifactFolders.id, folderId),
        eq(artifactFolders.companyId, companyId),
        isNull(artifactFolders.deletedAt),
    )).limit(1);
    return folder || null;
}

export function sanitizeFolderName(input: unknown) {
    return sanitizePathSegment(input);
}

export function buildFolderPath(parentPath: string | null, folderName: string) {
    return buildChildPath(parentPath, folderName);
}

export function isDescendantPath(candidate: string | null, ancestor: string) {
    if (!candidate) return false;
    return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}
