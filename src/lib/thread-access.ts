import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { messageThreads, threadMessages } from "@/db/schema";
import { agentTokenMayUseThread } from "@/lib/direct-chat-mode";

/**
 * MCP-side access to private direct threads (lib/direct-chat-mode.ts): a
 * person's private chat with an agent is reachable only by a token bound to
 * that agent. Every /api/mcp route that takes a thread or message id from the
 * caller checks it here; a refusal reads as "not found" so a foreign id is
 * never confirmed.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * token may not use (all of them for an unbound token; another agent's for a
 * bound one).
 */
export function privateThreadsHiddenFromToken(companyId: string, boundAgentId: string | null | undefined) {
    return boundAgentId
        ? sql`${threadMessages.threadId} NOT IN (SELECT id FROM message_threads WHERE company_id = ${companyId}::uuid AND type = 'direct' AND (is_private OR owner_user_id IS NOT NULL) AND direct_agent_id IS DISTINCT FROM ${boundAgentId}::uuid)`
        : sql`${threadMessages.threadId} NOT IN (SELECT id FROM message_threads WHERE company_id = ${companyId}::uuid AND type = 'direct' AND (is_private OR owner_user_id IS NOT NULL))`;
}

/**
 * A run start (POST /agents/runs, or the `run` header of a run-events batch)
 * may point at a private direct thread, directly or via its trigger message,
 * only from a token bound to that thread's agent.
 */
export async function mcpTokenMayStartRun(companyId: string, boundAgentId: string | null | undefined, input: { threadId?: string | null; triggerMessageId?: string | null }): Promise<boolean> {
    return (await mcpTokenMayUseThreadId(companyId, boundAgentId, input.threadId))
        && (await mcpTokenMayUseMessageId(companyId, boundAgentId, input.triggerMessageId));
}
