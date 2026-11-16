import { db } from "@/db";
import { artifactFolders, artifacts, users } from "@/db/schema";
import { and, eq, isNull, like, or, type InferModel } from "drizzle-orm";
import { buildChildPath, sanitizePathSegment } from "@/lib/path-utils";
import { storageAdapter } from "@/lib/storage";
import { UPLOADS_ROOT_FOLDER_KIND, USER_UPLOADS_FOLDER_KIND } from "@/lib/artifact-visibility";

/** Preferred path and display name of the managed uploads root. */
export const UPLOADS_ROOT_PATH = "uploads";
export const UPLOADS_ROOT_NAME = "Uploads";

export async function findActiveFolder(companyId: string, folderId: string): Promise<InferModel<typeof artifactFolders> | null> {
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

type FolderRow = InferModel<typeof artifactFolders>;

/** The company's managed uploads root: kind `uploads_root` only, never a regular folder that happens to be named "uploads". */
async function liveRootUploadsFolder(companyId: string): Promise<FolderRow | null> {
    const [folder] = await db.select().from(artifactFolders).where(and(
        eq(artifactFolders.companyId, companyId),
        eq(artifactFolders.kind, UPLOADS_ROOT_FOLDER_KIND),
        isNull(artifactFolders.deletedAt),
    )).limit(1);
    return folder || null;
}

/** Paths the managed root may take, in order: `uploads`, then `user-uploads`, `user-uploads-2`, … */
function uploadsRootPathCandidates(): string[] {
    return [UPLOADS_ROOT_PATH, "user-uploads", ...Array.from({ length: 18 }, (_, i) => `user-uploads-${i + 2}`)];
}

/** A root-level path no live folder or file uses yet (a regular "uploads" folder is never adopted). */
async function freeUploadsRootPath(companyId: string): Promise<string> {
    for (const candidate of uploadsRootPathCandidates()) {
        const [folder] = await db.select({ id: artifactFolders.id }).from(artifactFolders).where(and(
            eq(artifactFolders.companyId, companyId),
            eq(artifactFolders.path, candidate),
            isNull(artifactFolders.deletedAt),
        )).limit(1);
        if (folder) continue;
        const [file] = await db.select({ id: artifacts.id }).from(artifacts).where(and(
            eq(artifacts.companyId, companyId),
            isNull(artifacts.deletedAt),
            or(eq(artifacts.path, candidate), like(artifacts.path, `${candidate}/%`)),
        )).limit(1);
        if (!file) return candidate;
    }
    throw new Error("Unable to find a free path for the uploads folder");
}

async function liveUserUploadsFolder(companyId: string, userId: string): Promise<FolderRow | null> {
    const [folder] = await db.select().from(artifactFolders).where(and(
        eq(artifactFolders.companyId, companyId),
        eq(artifactFolders.kind, USER_UPLOADS_FOLDER_KIND),
        eq(artifactFolders.ownerUserId, userId),
        isNull(artifactFolders.deletedAt),
    )).limit(1);
    return folder || null;
}

/** The name a person's uploads folder shows: their display name, else the local part of their email. */
export function userUploadsFolderName(user: { displayName?: string | null; email?: string | null } | null | undefined): string {
    const display = user?.displayName?.trim();
    if (display) return display.slice(0, 120);
    const local = user?.email?.split("@")[0]?.trim();
    return local ? local.slice(0, 120) : "Uploads";
}

/**
 * Get or create the person's private uploads folder, `<root>/<userId>`
 * (kind `user_uploads`, owner_user_id set), under the company's managed
 * uploads root (kind `uploads_root`, shown as "Uploads"). The root lives at
 * `uploads`, or at the first free `user-uploads[-N]` when a regular folder or
 * file already uses that path: a regular folder is never adopted, so the
 * managed-folder guards always apply. Race-safe: concurrent first uploads
 * insert with ON CONFLICT DO NOTHING against artifact_folders_uploads_root_unique
 * / artifact_folders_user_uploads_unique and read back the winner. Visibility
 * rules: lib/artifact-visibility.ts.
 */
export async function ensureUserUploadsFolder(companyId: string, userId: string): Promise<FolderRow> {
    const existing = await liveUserUploadsFolder(companyId, userId);
    if (existing) return existing;

    let root = await liveRootUploadsFolder(companyId);
    if (!root) {
        const rootPath = await freeUploadsRootPath(companyId);
        await storageAdapter.ensureDirectory({ companyId, logicalPath: rootPath });
        await db.insert(artifactFolders).values({
            companyId,
            name: UPLOADS_ROOT_NAME,
            path: rootPath,
            kind: UPLOADS_ROOT_FOLDER_KIND,
            metadataJson: { system: true },
            createdByType: "system",
            createdById: null,
        }).onConflictDoNothing(); // artifact_folders_uploads_root_unique: a concurrent first upload won
        root = await liveRootUploadsFolder(companyId);
        if (!root) throw new Error("Unable to create the uploads folder");
    }

    const [user] = await db.select({ displayName: users.displayName, email: users.email })
        .from(users).where(eq(users.id, userId)).limit(1);
    const path = buildChildPath(root.path, userId);
    await storageAdapter.ensureDirectory({ companyId, logicalPath: path });
    await db.insert(artifactFolders).values({
        companyId,
        parentFolderId: root.id,
        name: userUploadsFolderName(user),
        path,
        kind: USER_UPLOADS_FOLDER_KIND,
        ownerUserId: userId,
        metadataJson: { system: true },
        createdByType: "human",
        createdById: userId,
    }).onConflictDoNothing();
    const folder = await liveUserUploadsFolder(companyId, userId);
    if (!folder) throw new Error("Unable to create the uploads folder");
    return folder;
}
