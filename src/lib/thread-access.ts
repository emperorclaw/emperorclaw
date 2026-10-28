import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, messageThreads, threadMessages, threadParticipants } from "@/db/schema";
import { agentTokenMayUseThread } from "@/lib/direct-chat-mode";
import { resolveAgentId } from "@/lib/mcp";
import { isAgentPairThread } from "@/lib/groups";
import { mentionedAgentIds } from "@/lib/message-routing";

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
        targetAgentId: threadMessages.targetAgentId, text: threadMessages.text,
        type: messageThreads.type, directAgentId: messageThreads.directAgentId,
        description: messageThreads.description, createdByType: messageThreads.createdByType,
    }).from(threadMessages)
        .innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
        .where(and(eq(threadMessages.id, messageId), eq(threadMessages.companyId, companyId))).limit(1);
    if (!source) return false;
    if (postThreadId && UUID_RE.test(postThreadId) && postThreadId !== source.threadId) return false;
    if (source.senderType === "agent" && source.senderId === agentId) return false;
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
