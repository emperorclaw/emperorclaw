import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, messageThreads, threadMessages, threadParticipants } from "@/db/schema";
import { agentTokenMayUseThread } from "@/lib/direct-chat-mode";
import { resolveAgentId } from "@/lib/mcp";
import { GROUP_THREAD_TYPE, isAgentPairThread } from "@/lib/groups";
import { mcpAccessForAgent, mcpMayUseThread } from "@/lib/mcp-access";
import { mentionedAgentIds, unreachableMentionsOf } from "@/lib/message-routing";

/**
 * MCP-side access to private direct threads (lib/direct-chat-mode.ts): a
 * person's private chat with an agent is reachable only when the request acts
 * as that agent (see mcpActingAgentId). Every /api/mcp route that takes a
 * thread or message id from the caller checks it here; a refusal reads as
 * "not found" so a foreign id is never confirmed.
 *
 * The `boundAgentId` parameter of the helpers below is that ACTING agent, not
 * necessarily the token's binding.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agent a request acts as for private-thread checks.
 *
 * - A token bound to an agent always acts as that agent (routes keep refusing
 *   a request that names another one, as before).
 * - A company-wide token (agent_id null) is an operator credential that may act
 *   as any agent of the company it names (same trust model as
 *   resolveBoundAgentId / mcpRouteAccess): it acts as the named agent once that
 *   resolves in the company, so a bridge syncing or replying as X reaches X's
 *   private direct threads and never another agent's.
 * - Nothing named, or a name that does not resolve: null, which keeps every
 *   private direct thread hidden.
 */
export async function mcpActingAgentId(
    companyId: string,
    token: { agentId?: string | null } | null | undefined,
    requestedAgentId: unknown,
): Promise<string | null> {
    const bound = token?.agentId || null;
    if (bound) return bound;
    if (typeof requestedAgentId !== "string" || !requestedAgentId.trim()) return null;
    try {
        return await resolveAgentId(companyId, requestedAgentId);
    } catch {
        return null;
    }
}

const privacyColumns = {
    type: messageThreads.type,
    ownerUserId: messageThreads.ownerUserId,
    isPrivate: messageThreads.isPrivate,
    directAgentId: messageThreads.directAgentId,
};

/** False when the thread is a private direct thread this token may not use. Unknown ids pass (callers 404 them). */
export async function mcpTokenMayUseThreadId(companyId: string, boundAgentId: string | null | undefined, threadId: string | null | undefined): Promise<boolean> {
    if (!threadId || !UUID_RE.test(threadId)) return true;
    const [thread] = await db.select(privacyColumns).from(messageThreads)
        .where(and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId))).limit(1);
    return !thread || agentTokenMayUseThread(thread, boundAgentId);
}

/** Same check for the thread a message lives in. */
export async function mcpTokenMayUseMessageId(companyId: string, boundAgentId: string | null | undefined, messageId: string | null | undefined): Promise<boolean> {
    if (!messageId || !UUID_RE.test(messageId)) return true;
    const [thread] = await db.select(privacyColumns).from(threadMessages)
        .innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
        .where(and(eq(threadMessages.id, messageId), eq(threadMessages.companyId, companyId))).limit(1);
    return !thread || agentTokenMayUseThread(thread, boundAgentId);
}

/**
 * SQL predicate on thread_messages.thread_id: hide private direct threads the
 * acting agent may not use (all of them when no agent acts; another agent's
 * otherwise).
 */
export function privateThreadsHiddenFromToken(companyId: string, boundAgentId: string | null | undefined) {
    return boundAgentId
        ? sql`${threadMessages.threadId} NOT IN (SELECT id FROM message_threads WHERE company_id = ${companyId}::uuid AND type = 'direct' AND (is_private OR owner_user_id IS NOT NULL) AND direct_agent_id IS DISTINCT FROM ${boundAgentId}::uuid)`
        : sql`${threadMessages.threadId} NOT IN (SELECT id FROM message_threads WHERE company_id = ${companyId}::uuid AND type = 'direct' AND (is_private OR owner_user_id IS NOT NULL))`;
}

/**
 * A run start (POST /agents/runs, or the `run` header of a run-events batch)
 * may point at a private direct thread, directly or via its trigger message,
 * only when the request acts as that thread's agent.
 */
export async function mcpTokenMayStartRun(companyId: string, boundAgentId: string | null | undefined, input: { threadId?: string | null; triggerMessageId?: string | null }): Promise<boolean> {
    return (await mcpTokenMayUseThreadId(companyId, boundAgentId, input.threadId))
        && (await mcpTokenMayUseMessageId(companyId, boundAgentId, input.triggerMessageId));
}

/**
 * Is this post a real reply by `agentId` to a message it was sent? Verified on
 * the server, never taken from the caller: the message exists in the company,
 * lives in the same thread the post goes to (`postThreadId` when the caller
 * names one; otherwise the post goes to the message's own thread), was not
 * sent by the agent itself, and was addressed to it: targeted at it, in its
 * own direct thread or agent pair thread, or @mentioning it.
 */
export async function isVerifiedReplyBy(companyId: string, agentId: string | null, postThreadId: string | null | undefined, messageId: unknown): Promise<boolean> {
    if (!agentId || typeof messageId !== "string" || !UUID_RE.test(messageId)) return false;
    const [source] = await db.select({
        threadId: threadMessages.threadId, senderType: threadMessages.senderType, senderId: threadMessages.senderId,
        targetAgentId: threadMessages.targetAgentId, text: threadMessages.text, metadataJson: threadMessages.metadataJson,
        type: messageThreads.type, directAgentId: messageThreads.directAgentId,
        description: messageThreads.description, createdByType: messageThreads.createdByType,
    }).from(threadMessages)
        .innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
        .where(and(eq(threadMessages.id, messageId), eq(threadMessages.companyId, companyId))).limit(1);
    if (!source) return false;
    if (postThreadId && UUID_RE.test(postThreadId) && postThreadId !== source.threadId) return false;
    if (source.senderType === "agent" && source.senderId === agentId) return false;
    // A person who may not use this agent never addressed it (0.20, decideDelivery).
    if (source.senderType === "human" && unreachableMentionsOf(source.metadataJson).has(agentId)) return false;
    if (source.targetAgentId === agentId) return true;
    if (source.type === "direct" && source.directAgentId === agentId) return true;
    if (isAgentPairThread(source)) {
        const [member] = await db.select({ id: threadParticipants.id }).from(threadParticipants).where(and(
            eq(threadParticipants.companyId, companyId), eq(threadParticipants.threadId, source.threadId),
            eq(threadParticipants.participantType, "agent"), eq(threadParticipants.participantId, agentId),
        )).limit(1);
        return Boolean(member);
    }
    const roster = await db.select({ id: agents.id, name: agents.name }).from(agents)
        .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
    return mentionedAgentIds(source.text ?? "", roster).has(agentId);
}

export type McpThreadReadVerdict =
    | { ok: true; thread: typeof messageThreads.$inferSelect }
    | { ok: false; status: 403 | 404; error: string };

type ThreadReadFields = {
    id: string;
    type: string;
    ownerUserId?: string | null;
    isPrivate?: boolean | null;
    directAgentId?: string | null;
    projectId?: string | null;
    taskId?: string | null;
    description: string | null;
    createdByType: string | null;
};

const THREAD_NOT_FOUND = { status: 404 as const, error: "Thread not found" };
const NOT_A_GROUP_MEMBER = { status: 403 as const, error: "Access denied: this agent is not a member of that group" };

/**
 * Why an MCP request may not read each of these threads (absent = readable).
 * One rule for GET /api/mcp/threads/[id]/messages, read_thread,
 * wait_for_reply and list_threads:
 * - a person's private direct thread only when acting as its agent
 *   (`actingAgentId`; MCP tools pass the token's bound agent only, so an
 *   operator connection never reads one);
 * - a project/task thread only inside the bound agent's data scope;
 * - a two-agent pair thread only when acting as one of its two agents (an
 *   operator never lists or reads one);
 * - another group, for a token bound to an agent, only when it is a member.
 * Batched: one membership query for the whole list.
 */
export async function mcpThreadReadRefusals(
    companyId: string,
    threads: readonly ThreadReadFields[],
    actingAgentId: string | null,
    boundAgentId: string | null,
): Promise<Map<string, { status: 403 | 404; error: string }>> {
    const refusals = new Map<string, { status: 403 | 404; error: string }>();
    const access = await mcpAccessForAgent(companyId, boundAgentId);
    await Promise.all(threads.map(async (thread) => {
        if (!agentTokenMayUseThread(thread, actingAgentId) || !(await mcpMayUseThread(companyId, access, thread))) {
            refusals.set(thread.id, THREAD_NOT_FOUND);
        }
    }));
    const groups = threads.filter((t) => t.type === GROUP_THREAD_TYPE && !refusals.has(t.id));
    const agentIds = [...new Set([actingAgentId, boundAgentId].filter((id): id is string => Boolean(id)))];
    const memberships = new Set<string>();
    if (groups.length > 0 && agentIds.length > 0) {
        const rows = await db.select({ threadId: threadParticipants.threadId, agentId: threadParticipants.participantId })
            .from(threadParticipants).where(and(
                eq(threadParticipants.companyId, companyId),
                eq(threadParticipants.participantType, "agent"),
                inArray(threadParticipants.threadId, groups.map((g) => g.id)),
                inArray(threadParticipants.participantId, agentIds),
            ));
        for (const row of rows) memberships.add(`${row.threadId}:${row.agentId}`);
    }
    for (const group of groups) {
        if (isAgentPairThread(group)) {
            if (!actingAgentId || !memberships.has(`${group.id}:${actingAgentId}`)) refusals.set(group.id, THREAD_NOT_FOUND);
        } else if (boundAgentId && !memberships.has(`${group.id}:${boundAgentId}`)) {
            refusals.set(group.id, NOT_A_GROUP_MEMBER);
        }
    }
    return refusals;
}

/** mcpThreadReadRefusals for one thread id, loading the thread. */
export async function mcpThreadReadVerdict(
    companyId: string,
    threadId: string,
    actingAgentId: string | null,
    boundAgentId: string | null,
): Promise<McpThreadReadVerdict> {
    if (!UUID_RE.test(threadId)) return { ok: false, ...THREAD_NOT_FOUND };
    const [thread] = await db.select().from(messageThreads)
        .where(and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId))).limit(1);
    if (!thread) return { ok: false, ...THREAD_NOT_FOUND };
    const refusal = (await mcpThreadReadRefusals(companyId, [thread], actingAgentId, boundAgentId)).get(thread.id);
    return refusal ? { ok: false, ...refusal } : { ok: true, thread };
}
