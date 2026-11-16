/**
 * Who may see a Storage file or folder: the single source of truth.
 *
 * Every rule exists twice: the JS predicate here (one record loaded by id;
 * pure, so the client may import it) and its SQL twin in
 * lib/artifact-visibility-server.ts (lists, folder contents, search), so a
 * list never shows what the record route would refuse.
 *
 * Files
 * - A "private human upload" is visibility 'private' created by a person.
 *   A "chat upload" is one sent in chat: a file or voice message
 *   (source_kind 'chat-attachment' / 'voice-message') or any private human
 *   upload inside a person's `user_uploads` folder. Everything else (company
 *   files, agent output, system files) keeps the behavior it had:
 *   company-visible within the existing project/customer scopes.
 * - People (every private human upload): the uploader, owners and admins see
 *   it in lists, folder contents and search; other members and viewers never
 *   do. A legacy row with no uploader stays visible (it belongs to nobody).
 *   Single-record reads (open, download, chat file card) also allow anyone who
 *   can read a message the file is attached to (humanMayOpenArtifact in
 *   lib/artifact-visibility-server.ts). Changes stay with the uploader and
 *   owners/admins.
 * - Agents, chat uploads only: readable only when attached to a message
 *   (thread_messages.metadata_json.attachments) in a thread the agent may
 *   read: team chat, its own direct chat, or a group / pair thread it is a
 *   participant of. Any other thread type never counts. Agents never change a
 *   chat upload. Operator tokens acting as no agent never see one (mirrors
 *   privateThreadsHiddenFromToken in lib/thread-access.ts).
 * - Agents, every other private human upload (a private Storage upload):
 *   unchanged, agents and operator tokens see and change it within their
 *   project/customer scope; list_storage_files still leaves it out.
 *
 * Folders
 * - A `user_uploads` folder (<uploads root>/<userId>) belongs to its owner:
 *   other members neither see it nor open, write into or change it.
 *   Owners/admins see every one. Agents see the folder row (its files follow
 *   the file rule) but never write into it.
 * - The shared uploads root (kind `uploads_root`) and every `user_uploads`
 *   folder are managed: nobody renames, moves or deletes them, creates one by
 *   hand, or writes into the root. Single files inside can still be deleted by
 *   their uploader or an admin.
 */

import { roleGte, type Role } from "@/lib/role-matrix";

export const USER_UPLOADS_FOLDER_KIND = "user_uploads";
export const UPLOADS_ROOT_FOLDER_KIND = "uploads_root";
/** Folder kinds only the system creates (lib/artifact-folders.ts ensureUserUploadsFolder). */
export const RESERVED_FOLDER_KINDS: ReadonlySet<string> = new Set([USER_UPLOADS_FOLDER_KIND, UPLOADS_ROOT_FOLDER_KIND]);
/** source_kind of files sent in chat (app/api/chat/attachments, app/api/chat/voice). */
export const CHAT_UPLOAD_SOURCE_KINDS = ["chat-attachment", "voice-message"] as const;

/** A signed-in person reading Storage. */
export type HumanViewer = { userId: string | null | undefined; role: Role | string | null | undefined };

export type ArtifactVisibilityFields = {
    visibility: string | null;
    createdByType: string | null;
    createdById: string | null;
};

export type FolderVisibilityFields = {
    kind?: string | null;
    ownerUserId?: string | null;
};

/** Owners and admins see every file and folder of the company. */
export function isStorageAdmin(viewer: HumanViewer): boolean {
    return Boolean(viewer.role) && roleGte(viewer.role as Role, "admin");
}

export function isPrivateHumanUpload(file: ArtifactVisibilityFields): boolean {
    return file.visibility === "private" && file.createdByType === "human";
}

/** A private human upload sent in chat (see the header); `folderKind` is the kind of the file's folder, if any. */
export function isPrivateChatUpload(
    file: ArtifactVisibilityFields & { sourceKind?: string | null },
    folderKind?: string | null,
): boolean {
    if (!isPrivateHumanUpload(file)) return false;
    return (CHAT_UPLOAD_SOURCE_KINDS as readonly string[]).includes(file.sourceKind ?? "") || folderKind === USER_UPLOADS_FOLDER_KIND;
}

/** A requested folder kind a person or agent may not set (400 on create/update). */
export function isReservedFolderKind(kind: unknown): boolean {
    return typeof kind === "string" && RESERVED_FOLDER_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export function humanMayViewArtifact(file: ArtifactVisibilityFields, viewer: HumanViewer): boolean {
    if (!isPrivateHumanUpload(file) || !file.createdById) return true;
    if (isStorageAdmin(viewer)) return true;
    return Boolean(viewer.userId) && file.createdById === viewer.userId;
}

/** Changing a file (rename, visibility, move, replace, delete) needs the same right as seeing it in lists. */
export const humanMayChangeArtifact = humanMayViewArtifact;

export function isUserUploadsFolder(folder: FolderVisibilityFields | null | undefined): boolean {
    return folder?.kind === USER_UPLOADS_FOLDER_KIND;
}

/** The uploads root and the per-person folders are created, named and kept by the system. */
export function isManagedUploadsFolder(folder: FolderVisibilityFields | null | undefined): boolean {
    return Boolean(folder?.kind && RESERVED_FOLDER_KINDS.has(folder.kind));
}

export function humanMayViewFolder(folder: FolderVisibilityFields, viewer: HumanViewer): boolean {
    if (!isUserUploadsFolder(folder)) return true;
    if (isStorageAdmin(viewer)) return true;
    return Boolean(viewer.userId) && folder.ownerUserId === viewer.userId;
}

/** Writing into a folder (upload, move a file in, create a subfolder): one you may see, never the uploads root. */
export function humanMayWriteIntoFolder(folder: FolderVisibilityFields, viewer: HumanViewer): boolean {
    return folder.kind !== UPLOADS_ROOT_FOLDER_KIND && humanMayViewFolder(folder, viewer);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Agents (and operator tokens) never change a chat upload; other files as before. */
export function agentMayChangeArtifact(
    file: ArtifactVisibilityFields & { sourceKind?: string | null },
    folderKind?: string | null,
): boolean {
    return !isPrivateChatUpload(file, folderKind);
}

/** Agents never write into a person's uploads folder or the uploads root. */
export function agentMayWriteIntoFolder(folder: FolderVisibilityFields | null | undefined): boolean {
    return !isManagedUploadsFolder(folder);
}
