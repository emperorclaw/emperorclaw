import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "@/db";
import { messageThreads, threadParticipants } from "@/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { sendThreadMessageFromMcp } from "@/lib/openclaw/messaging";
import { jsonResult, errorResult } from "../result";
import {
    addGroupMembers,
    archiveGroup,
    createGroup,
    getGroup,
    GroupError,
    isAgentGroupMember,
    isAgentPairThread,
    listGroups,
    removeGroupMember,
    updateGroup,
    type GroupActor,
} from "@/lib/groups";
import { resolveAgentId } from "@/lib/mcp";

/**
 * Private agent pair threads are a two-agent handoff. They must not leak into
 * an unscoped thread listing: keep one only when the caller agent is one of its
 * two participants. Operator tokens (no bound agent) see none.
 */
async function excludePrivatePairThreads(
    companyId: string,
    threads: (typeof messageThreads.$inferSelect)[],
    callerAgentId: string | null,
): Promise<(typeof messageThreads.$inferSelect)[]> {
    const pairs = threads.filter((t) => isAgentPairThread(t));
    if (pairs.length === 0) return threads;
    const allowed = new Set<string>();
    if (callerAgentId) {
        const membership = await db.select({ threadId: threadParticipants.threadId }).from(threadParticipants).where(and(
            eq(threadParticipants.companyId, companyId),
            eq(threadParticipants.participantType, "agent"),
            eq(threadParticipants.participantId, callerAgentId),
        ));
        for (const row of membership) allowed.add(row.threadId);
    }
    return threads.filter((t) => !isAgentPairThread(t) || allowed.has(t.id));
}

export function registerMessagingTools(server: McpServer, companyId: string, callerAgentId?: string | null) {
    server.registerTool("send_message", {
        title: "Send Message",
        description: "Send a message to team chat (visible to all agents, use for informational updates or @mentioning a specific agent) , a direct thread (private, one human-to-one agent), or a group chat (pass its threadId; only the group's members receive it, @mention a member to get a reply; a human's @all reaches every member, never post @all yourself; you must be a member to post). Only act on a team chat message if your own @name is explicitly mentioned in it. text is GitHub Markdown and may include rich blocks the chat renders as UI: ```stats (JSON list of {label, value, delta?, hint?, progress?}), ```chart (JSON {type: bar|line|area|pie|donut, labels, series:[{name, data}]}), ````tabs (Markdown split by `=== Label` lines), ```html (self-contained sandboxed widget; no network; theme via CSS vars like var(--card)), and ```choices (JSON {question, options:[{label, prompt?}]} rendered as reply buttons). Link records as [label](emperor://task|project|agent|knowledge|artifact/<id>) to show their live status. Use a standalone knowledge link to open its note; a standalone artifact link shows a file card with Open/Download and a preview for PNG/JPEG/GIF/WebP. Use real IDs from list_knowledge/list_storage_files or uploads. Links do not change access. Use them when data reads better visually.",
        inputSchema: {
            text: z.string().min(1),
            threadId: z.string().optional().describe("Existing thread to reply in"),
            agentId: z.string().optional().describe("Sending agent's id or name"),
            targetAgentId: z.string().optional().describe("For direct messages: the recipient agent"),
            threadType: z.enum(["team", "direct"]).optional(),
        },
    }, async ({ text, threadId, agentId, targetAgentId, threadType }) => {
        try {
            const result = await sendThreadMessageFromMcp({ companyId, text, threadId, agentId, targetAgentId, threadType });
            return jsonResult(result);
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("list_threads", {
        title: "List Threads",
        description: "List message threads for this company (team chat, direct threads, and group chats), most recently created first.",
        inputSchema: {
            type: z.enum(["team", "direct", "group"]).optional(),
            limit: z.number().int().min(1).max(200).optional(),
        },
    }, async ({ type, limit }) => {
        try {
            const conditions = [eq(messageThreads.companyId, companyId), isNull(messageThreads.archivedAt)];
            if (type) conditions.push(eq(messageThreads.type, type));
            let threads = await db.select().from(messageThreads)
                .where(and(...conditions))
                .orderBy(desc(messageThreads.createdAt))
                .limit(limit || 50);
            // Private agent pair threads are never listed except to the caller
            // agent that is one of their two participants.
            threads = await excludePrivatePairThreads(companyId, threads, callerAgentId ?? null);
            return jsonResult({ threads });
        } catch (e) {
            return errorResult(e);
        }
    });

    // ─── Group chats ────────────────────────────────────────────────────────
    // A group is a shared channel like team chat, for its members only: only
    // member agents receive it and they answer when @mentioned. Agents and
    // humans create and manage groups alike; an agent-bound connection may
    // only change groups its agent belongs to.

    const actorFor = async (agentRef?: string): Promise<GroupActor> => {
        if (callerAgentId) return { type: "agent", id: callerAgentId };
        if (agentRef) return { type: "agent", id: await resolveAgentId(companyId, agentRef) };
        return { type: "system", id: null };
    };
    const requireMember = async (groupId: string) => {
        if (callerAgentId && !(await isAgentGroupMember(companyId, groupId, callerAgentId))) {
            throw new GroupError("This agent is not a member of that group", 403);
        }
    };
    const agentRefs = z.array(z.string()).max(50).optional().describe("Agent ids or exact names");
    const userRefs = z.array(z.string()).max(50).optional().describe("Human user ids (company members)");

    server.registerTool("list_groups", {
        title: "List Groups",
        description: "List group chats with their purpose and members. mine=true returns only groups the calling agent belongs to. Private agent pair threads are never listed.",
        inputSchema: { mine: z.boolean().optional() },
    }, async ({ mine }) => {
        try {
            return jsonResult({ groups: await listGroups(companyId, { agentId: mine ? callerAgentId ?? null : null, includePairThreads: false }) });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("get_group", {
        title: "Get Group",
        description: "Get one group chat: name, purpose, and members (agents and humans). A private pair thread is readable only by its two agents (or an operator).",
        inputSchema: { groupId: z.string(), agentId: z.string().optional().describe("Calling agent's id or name (operator connections only)") },
    }, async ({ groupId, agentId }) => {
        try {
            return jsonResult({ group: await getGroup(companyId, groupId, await actorFor(agentId)) });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("create_group", {
        title: "Create Group",
        description: "Create a group chat for a set of agents and humans, e.g. a 'Development team' with the devs and the tester. Only members receive its messages; they reply when @mentioned, like team chat. The creating agent joins automatically. Post into it with send_message and its threadId.",
        inputSchema: {
            title: z.string().min(1).max(80),
            description: z.string().max(600).optional().describe("The group's purpose; shown to every member agent"),
            agentIds: agentRefs,
            humanUserIds: userRefs,
            agentId: z.string().optional().describe("Creating agent's id or name (operator connections only)"),
        },
    }, async ({ title, description, agentIds, humanUserIds, agentId }) => {
        try {
            const group = await createGroup(companyId, await actorFor(agentId), { title, description, agentIds, humanUserIds });
            return jsonResult({ group, threadId: group.id });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("update_group", {
        title: "Update Group",
        description: "Rename a group chat or change its purpose.",
        inputSchema: {
            groupId: z.string(),
            title: z.string().min(1).max(80).optional(),
            description: z.string().max(600).optional(),
        },
    }, async ({ groupId, title, description }) => {
        try {
            await requireMember(groupId);
            return jsonResult({ group: await updateGroup(companyId, groupId, { title, description }) });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("add_group_members", {
        title: "Add Group Members",
        description: "Add agents and/or humans to a group chat. Adding someone who is already a member is a no-op.",
        inputSchema: { groupId: z.string(), agentIds: agentRefs, humanUserIds: userRefs },
    }, async ({ groupId, agentIds, humanUserIds }) => {
        try {
            await requireMember(groupId);
            return jsonResult({ group: await addGroupMembers(companyId, groupId, { agentIds, humanUserIds }) });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("remove_group_member", {
        title: "Remove Group Member",
        description: "Remove one agent or human from a group chat. A removed agent stops receiving the group.",
        inputSchema: { groupId: z.string(), kind: z.enum(["agent", "human"]), memberId: z.string().describe("Agent id/name or human user id") },
    }, async ({ groupId, kind, memberId }) => {
        try {
            await requireMember(groupId);
            return jsonResult({ group: await removeGroupMember(companyId, groupId, { kind, id: memberId }) });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("archive_group", {
        title: "Archive Group",
        description: "Archive a group chat. Its history is kept, but it stops delivering messages.",
        inputSchema: { groupId: z.string() },
    }, async ({ groupId }) => {
        try {
            await requireMember(groupId);
            await archiveGroup(companyId, groupId);
            return jsonResult({ ok: true });
        } catch (e) {
            return errorResult(e);
        }
    });
}
