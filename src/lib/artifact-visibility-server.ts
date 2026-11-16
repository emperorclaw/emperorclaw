/**
 * SQL twins of the Storage visibility rules in lib/artifact-visibility.ts
 * (read that header first), plus the database checks for one private upload:
 * an agent's (agentArtifactAccess) and a person's single-record read
 * (humanMayOpenArtifact). Server-only: imports the database.
 */

import { and, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { db } from "@/db";
import { artifactFolders, artifacts, messageThreads, threadMessages } from "@/db/schema";
import { agentUseFor, type AgentAccessViewer } from "@/lib/agent-access-server";
import { userMayUseThread } from "@/lib/direct-chat-mode";
import { GROUP_THREAD_TYPE, isAgentPairThread } from "@/lib/groups";
import { requireGroupInScope } from "@/lib/group-route";
import {
    CHAT_UPLOAD_SOURCE_KINDS, humanMayViewArtifact, isPrivateHumanUpload, isStorageAdmin, USER_UPLOADS_FOLDER_KIND,
    type ArtifactVisibilityFields, type HumanViewer,
} from "@/lib/artifact-visibility";

/** Column references of the artifacts table (or an alias of it, e.g. search's `a`). */
export type ArtifactColumnRefs = {
    id: SQLWrapper;
    visibility: SQLWrapper;
    createdByType: SQLWrapper;
    createdById: SQLWrapper;
    sourceKind?: SQLWrapper;
    folderId?: SQLWrapper;
};

export const ARTIFACT_COLUMNS: ArtifactColumnRefs = {
    id: artifacts.id,
    visibility: artifacts.visibility,
    createdByType: artifacts.createdByType,
    createdById: artifacts.createdById,
    sourceKind: artifacts.sourceKind,
    folderId: artifacts.folderId,
};

export type FolderColumnRefs = { kind: SQLWrapper; ownerUserId: SQLWrapper };

export const FOLDER_COLUMNS: FolderColumnRefs = {
    kind: artifactFolders.kind,
    ownerUserId: artifactFolders.ownerUserId,
};

function notPrivateHumanUpload(cols: ArtifactColumnRefs): SQL {
    return sql`(${cols.visibility} <> 'private' OR ${cols.createdByType} <> 'human')`;
}

/** SQL twin of humanMayViewArtifact. undefined = no filter (owners/admins). */
export function humanArtifactCondition(viewer: HumanViewer, cols: ArtifactColumnRefs = ARTIFACT_COLUMNS): SQL | undefined {
    if (isStorageAdmin(viewer)) return undefined;
    const mine = viewer.userId ? sql` OR ${cols.createdById} = ${viewer.userId}::uuid` : sql``;
    return sql`(${notPrivateHumanUpload(cols)} OR ${cols.createdById} IS NULL${mine})`;
}

/** SQL twin of humanMayViewFolder. undefined = no filter (owners/admins). */
export function humanFolderCondition(viewer: HumanViewer, cols: FolderColumnRefs = FOLDER_COLUMNS): SQL | undefined {
    if (isStorageAdmin(viewer)) return undefined;
    const mine = viewer.userId ? sql` OR ${cols.ownerUserId} = ${viewer.userId}::uuid` : sql``;
    return sql`(${cols.kind} <> ${USER_UPLOADS_FOLDER_KIND}${mine})`;
}

/** SQL twin of isPrivateChatUpload (never NULL). */
function privateChatUpload(cols: ArtifactColumnRefs): SQL {
    if (!cols.sourceKind || !cols.folderId) throw new Error("privateChatUpload needs sourceKind and folderId columns");
    const kinds = sql.join(CHAT_UPLOAD_SOURCE_KINDS.map((kind) => sql`${kind}`), sql`, `);
    return sql`(${cols.visibility} = 'private' AND ${cols.createdByType} = 'human' AND (
        coalesce(${cols.sourceKind}, '') IN (${kinds})
        OR EXISTS (SELECT 1 FROM artifact_folders vis_f WHERE vis_f.id = ${cols.folderId} AND vis_f.kind = ${USER_UPLOADS_FOLDER_KIND})
    ))`;
}

/**
 * TRUE when the file id is attached to a message, in the company, of a thread
 * the agent may read. Fails closed, one rule per thread type:
 * - team chat: any agent;
 * - direct: only that thread's agent;
 * - group (incl. a two-agent pair thread): only participant agents;
 * - anything else: never.
 * Uses thread_messages_attachments_idx.
 */
function attachedToThreadAgentMayRead(companyId: string, agentId: string, artifactId: SQLWrapper): SQL {
    return sql`EXISTS (
        SELECT 1 FROM thread_messages vis_tm
            JOIN message_threads vis_th ON vis_th.id = vis_tm.thread_id AND vis_th.company_id = ${companyId}::uuid
        WHERE vis_tm.company_id = ${companyId}::uuid
          AND (vis_tm.metadata_json -> 'attachments') @> jsonb_build_array(jsonb_build_object('id', (${artifactId})::text))
          AND (
            vis_th.type = 'team'
            OR (vis_th.type = 'direct' AND vis_th.direct_agent_id = ${agentId}::uuid)
            OR (vis_th.type = ${GROUP_THREAD_TYPE} AND EXISTS (
                SELECT 1 FROM thread_participants vis_tp
                WHERE vis_tp.thread_id = vis_th.id AND vis_tp.participant_type = 'agent'
                  AND vis_tp.participant_id = ${agentId}::uuid))
          )
    )`;
}

/**
 * The file rule for an MCP caller acting as `agentId` (null = an operator
 * token acting as no agent). A chat upload only when attached to a message
 * the agent may read; every other file as before. `hideOtherPrivateUploads`
 * keeps list_storage_files' older rule: it never lists private human uploads
 * that are not chat uploads.
 */
export function agentArtifactCondition(
    companyId: string,
    agentId: string | null | undefined,
    cols: ArtifactColumnRefs = ARTIFACT_COLUMNS,
    options: { hideOtherPrivateUploads?: boolean } = {},
): SQL {
    const chat = privateChatUpload(cols);
    const allowed: SQL[] = [notPrivateHumanUpload(cols)];
    if (!options.hideOtherPrivateUploads) allowed.push(sql`NOT ${chat}`);
    if (agentId) allowed.push(sql`(${chat} AND ${attachedToThreadAgentMayRead(companyId, agentId, cols.id)})`);
    return sql`(${sql.join(allowed, sql` OR `)})`;
}

/**
 * What an MCP caller acting as `agentId` may do with one file: "none" (the
 * route answers 404, never confirming the id), "read" (download/verify only:
 * a chat upload it was handed in a message) or "write". Evaluates the same SQL
 * as the lists, so a record route never disagrees with them.
 */
export async function agentArtifactAccess(
    companyId: string,
    agentId: string | null | undefined,
    file: ArtifactVisibilityFields & { id: string },
): Promise<"none" | "read" | "write"> {
    if (!isPrivateHumanUpload(file)) return "write";
    const result = await db.execute(sql`
        SELECT ${agentArtifactCondition(companyId, agentId)} AS readable, ${privateChatUpload(ARTIFACT_COLUMNS)} AS chat
        FROM artifacts WHERE ${artifacts.id} = ${file.id}::uuid AND ${artifacts.companyId} = ${companyId}::uuid`);
    const row = (result.rows as Array<{ readable: unknown; chat: unknown }>)[0];
    const truthy = (value: unknown) => value === true || value === "t";
    if (!row || !truthy(row.readable)) return "none";
    return truthy(row.chat) ? "read" : "write";
}

/** The 403 an agent gets for changing a person's private upload it may read. */
export const AGENT_PRIVATE_UPLOAD_READ_ONLY = "This file is a person's private chat upload: agents may read it but not change, move or delete it";
/** The 403 an agent gets for writing into a person's uploads folder. */
export const AGENT_UPLOADS_FOLDER_READ_ONLY = "That folder holds people's private uploads: agents cannot write into, change or delete it";

/**
 * Rule (c) for people, single-record reads only (GET /api/ui/artifacts/[id],
 * its download, and chat file cards in /api/ui/entities): a person may open a
 * private upload attached (metadata_json.attachments) to a message of a
 * thread they may read. Lists, folder contents and search keep the strict
 * rule; writes stay with the uploader and owners/admins.
 *
 * "May read the thread" is the same check GET /api/chat makes:
 * - team chat: everyone in the company;
 * - a direct chat: userMayUseThread (a private one only for its owner) and the
 *   agent must be usable by this person (agentUseFor === "full");
 * - a group: inside a restricted member's scope (requireGroupInScope); an
 *   agent pair thread only for owners/admins (who pass rule (b) anyway).
 * Unknown thread types never count (fail closed).
 */
export async function humanMayOpenArtifact(
    viewer: AgentAccessViewer,
    file: ArtifactVisibilityFields & { id: string },
): Promise<boolean> {
    if (humanMayViewArtifact(file, viewer)) return true;
    const threads = await db.selectDistinct({
        id: messageThreads.id, type: messageThreads.type, ownerUserId: messageThreads.ownerUserId,
        isPrivate: messageThreads.isPrivate, directAgentId: messageThreads.directAgentId,
        description: messageThreads.description, createdByType: messageThreads.createdByType,
    }).from(threadMessages)
        .innerJoin(messageThreads, and(eq(messageThreads.id, threadMessages.threadId), eq(messageThreads.companyId, viewer.companyId)))
        .where(and(
            eq(threadMessages.companyId, viewer.companyId),
            sql`(${threadMessages.metadataJson} -> 'attachments') @> jsonb_build_array(jsonb_build_object('id', ${file.id}::text))`,
        ));
    for (const thread of threads) {
        if (await humanMayReadThread(viewer, thread)) return true;
    }
    return false;
}

async function humanMayReadThread(
    viewer: AgentAccessViewer,
    thread: { id: string; type: string; ownerUserId: string | null; isPrivate: boolean | null; directAgentId: string | null; description: string | null; createdByType: string | null },
): Promise<boolean> {
    if (thread.type === "team") return true;
    if (thread.type === "direct") {
        if (!userMayUseThread(thread, viewer.userId)) return false;
        return !thread.directAgentId || (await agentUseFor(viewer, thread.directAgentId)) === "full";
    }
    if (thread.type === GROUP_THREAD_TYPE) {
        if (isAgentPairThread(thread)) return isStorageAdmin(viewer);
        if (!viewer.scope) return true;
        try {
            await requireGroupInScope(viewer.companyId, thread.id, viewer.userId, viewer.scope);
            return true;
        } catch {
            return false;
        }
    }
    return false;
}
