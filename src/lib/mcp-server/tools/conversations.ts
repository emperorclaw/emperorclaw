import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { agents, messageThreads, threadMessages, threadParticipants } from "@/db/schema";
import { AGENT_PAIR_DESCRIPTION, GROUP_THREAD_TYPE, pairThreadCounterpart } from "@/lib/groups";
import { resolveAgentId } from "@/lib/mcp";
import { mcpThreadReadVerdict } from "@/lib/thread-access";
import { jsonResult, errorResult } from "../result";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** read_thread page size. */
export const READ_THREAD_DEFAULT_LIMIT = 30;
export const READ_THREAD_MAX_LIMIT = 100;
/**
 * wait_for_reply holds the call open at most this long. MCP clients give a
 * tool call about 60 s on stateless HTTP (Codex's tool_timeout_sec defaults
 * to 60), so a wait always ends well inside that and the client calls again.
 */
export const WAIT_DEFAULT_SECONDS = 20;
export const WAIT_MAX_SECONDS = 25;
/** Waits one token may hold open at once in this process; more are refused. */
export const WAIT_MAX_CONCURRENT_PER_TOKEN = 5;
const WAIT_POLL_MS = 1500;
const WAIT_BATCH_MAX = 50;
/** A `since` this far ahead of the server clock is a mistake, not skew. */
const FUTURE_SINCE_TOLERANCE_MS = 5000;
/** Characters of the last message shown by list_threads. */
export const PREVIEW_CHARS = 140;

const openWaits = new Map<string, number>();

type MessageRow = typeof threadMessages.$inferSelect;

export type ConversationMessage = {
    messageId: string;
    senderType: string;
    senderId: string | null;
    senderName: string;
    text: string;
    createdAt: string;
    ack?: true;
};

/**
 * The messages a conversation shows: not cancelled, and not runtime control
 * traffic (the same rows /messages/sync leaves out). One filter for
 * read_thread, wait_for_reply and the list_threads previews.
 */
export function conversationMessageFilter(): SQL {
    return and(
        ne(threadMessages.deliveryState, "cancelled"),
        sql`NOT (${threadMessages.metadataJson} ? 'runtimeControl')`,
        sql`NOT (${threadMessages.metadataJson} ? 'runtimeGoalRequest')`,
    )!;
}

/** Keyset position of a message, compared in SQL so microsecond timestamps and ties are exact. */
function afterMessage(messageId: string): SQL {
    return sql`(${threadMessages.createdAt}, ${threadMessages.id}) > (SELECT created_at, id FROM thread_messages WHERE id = ${messageId}::uuid)`;
}
function beforeMessage(messageId: string): SQL {
    return sql`(${threadMessages.createdAt}, ${threadMessages.id}) < (SELECT created_at, id FROM thread_messages WHERE id = ${messageId}::uuid)`;
}

/** A cursor message id, checked to belong to this thread. */
async function threadAnchor(companyId: string, threadId: string, messageId: string, name: string): Promise<string> {
    if (!UUID_RE.test(messageId)) throw new Error(`${name} is not a message id`);
    const [anchor] = await db.select({ id: threadMessages.id }).from(threadMessages).where(and(
        eq(threadMessages.id, messageId), eq(threadMessages.companyId, companyId), eq(threadMessages.threadId, threadId),
    )).limit(1);
    if (!anchor) throw new Error(`${name} is not a message of that thread`);
    return anchor.id;
}

/**
 * Display names for the senders of a batch of messages: agents by their
 * current name, people and system posts by the name stored with the message,
 * and an operator connection's own posts (agent sender with no id) as such.
 */
export async function describeSenders(companyId: string, rows: readonly Pick<MessageRow, "senderType" | "senderId" | "metadataJson">[]): Promise<(row: Pick<MessageRow, "senderType" | "senderId" | "metadataJson">) => string> {
    const agentIds = [...new Set(rows
        .filter((r) => r.senderType === "agent" && r.senderId && UUID_RE.test(r.senderId))
        .map((r) => r.senderId as string))];
    const names = new Map<string, string>();
    if (agentIds.length > 0) {
        const found = await db.select({ id: agents.id, name: agents.name }).from(agents)
            .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
        for (const a of found) names.set(a.id, a.name);
    }
    return (row) => {
        const meta = (row.metadataJson && typeof row.metadataJson === "object" ? row.metadataJson : {}) as Record<string, unknown>;
        const stored = typeof meta.senderName === "string" && meta.senderName.trim() ? meta.senderName.trim() : null;
        if (row.senderType === "agent") {
            if (!row.senderId) return "Operator (MCP)";
            return names.get(row.senderId) ?? stored ?? "Agent";
        }
        if (row.senderType === "human") return stored ?? "Person";
        return stored ?? "System";
    };
}

function isAck(row: Pick<MessageRow, "metadataJson">): boolean {
    const meta = row.metadataJson as Record<string, unknown> | null;
    return Boolean(meta && typeof meta === "object" && meta.ack === true);
}

export async function toConversationMessages(companyId: string, rows: readonly MessageRow[]): Promise<ConversationMessage[]> {
    const nameOf = await describeSenders(companyId, rows);
    return rows.map((row) => ({
        messageId: row.id,
        senderType: row.senderType,
        senderId: row.senderId,
        senderName: nameOf(row),
        text: row.text,
        createdAt: row.createdAt.toISOString(),
        ...(isAck(row) ? { ack: true as const } : {}),
    }));
}

/**
 * The last message of each thread, for list_threads. One DISTINCT ON query
 * for the whole page. Callers pass only threads the caller may read.
 */
export async function lastMessagePreviews(companyId: string, threadIds: string[]) {
    const previews = new Map<string, { messageId: string; senderType: string; senderName: string; text: string; createdAt: string }>();
    if (threadIds.length === 0) return previews;
    const rows = await db.selectDistinctOn([threadMessages.threadId]).from(threadMessages)
        .where(and(
            eq(threadMessages.companyId, companyId),
            inArray(threadMessages.threadId, threadIds),
            conversationMessageFilter(),
        ))
        .orderBy(threadMessages.threadId, desc(threadMessages.createdAt), desc(threadMessages.id));
    const nameOf = await describeSenders(companyId, rows);
    for (const row of rows) {
        const text = row.text.length > PREVIEW_CHARS ? `${row.text.slice(0, PREVIEW_CHARS).trimEnd()}…` : row.text;
        previews.set(row.threadId, { messageId: row.id, senderType: row.senderType, senderName: nameOf(row), text, createdAt: row.createdAt.toISOString() });
    }
    return previews;
}

/**
 * The thread an agentId points read_thread at: for an operator connection,
 * that agent's shared direct thread (where send_message with targetAgentId
 * posts); for an agent-bound connection, its own shared direct thread, or its
 * two-agent pair thread with the other agent. Never creates one.
 */
async function conversationWithAgent(companyId: string, callerAgentId: string | null, agentRef: string): Promise<string | null> {
    const agentId = await resolveAgentId(companyId, agentRef);
    if (!callerAgentId || callerAgentId === agentId) {
        const [direct] = await db.select({ id: messageThreads.id }).from(messageThreads).where(and(
            eq(messageThreads.companyId, companyId),
            eq(messageThreads.type, "direct"),
            eq(messageThreads.directAgentId, agentId),
            isNull(messageThreads.ownerUserId),
            eq(messageThreads.isPrivate, false),
            isNull(messageThreads.archivedAt),
        )).orderBy(asc(messageThreads.createdAt)).limit(1);
        return direct?.id ?? null;
    }
    const pairs = await db.select({ id: messageThreads.id }).from(messageThreads)
        .innerJoin(threadParticipants, and(
            eq(threadParticipants.threadId, messageThreads.id),
            eq(threadParticipants.companyId, companyId),
            eq(threadParticipants.participantType, "agent"),
            eq(threadParticipants.participantId, callerAgentId),
        ))
        .where(and(
            eq(messageThreads.companyId, companyId),
            eq(messageThreads.type, GROUP_THREAD_TYPE),
            eq(messageThreads.description, AGENT_PAIR_DESCRIPTION),
            eq(messageThreads.createdByType, "system"),
            isNull(messageThreads.archivedAt),
        ));
    for (const pair of pairs) {
        if ((await pairThreadCounterpart(companyId, pair.id, callerAgentId)) === agentId) return pair.id;
    }
    return null;
}

function parseDate(value: string | undefined, name: string): Date | null {
    if (!value) return null;
    const date = new Date(value);
    if (isNaN(date.getTime())) throw new Error(`${name} must be an ISO date`);
    return date;
}

/** Messages the caller did not write: its own agent's posts, or an operator connection's posts (agent sender, no id). */
function notFromCaller(callerAgentId: string | null): SQL {
    return callerAgentId
        ? sql`NOT (${threadMessages.senderType} = 'agent' AND ${threadMessages.senderId} IS NOT DISTINCT FROM ${callerAgentId})`
        : sql`NOT (${threadMessages.senderType} = 'agent' AND ${threadMessages.senderId} IS NULL)`;
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });
}

/**
 * Reading conversations: every connection, operator or agent, under the same
 * visibility rules as GET /api/mcp/threads/[id]/messages (thread-access.ts
 * mcpThreadReadRefusals). The acting agent is only ever the token's bound
 * agent, so an operator connection never reads a person's private chat or a
 * two-agent pair thread.
 */
export function registerConversationTools(server: McpServer, companyId: string, callerAgentId?: string | null, tokenId?: string | null) {
    const caller = callerAgentId ?? null;
    const waitKey = tokenId ? `token:${tokenId}` : `company:${companyId}:agent:${caller ?? "-"}`;

    server.registerTool("read_thread", {
        title: "Read Thread",
        description: `Read the messages of one thread, oldest first. Pass threadId (from send_message or list_threads), or agentId for your conversation with that agent (an operator connection reads the agent's shared direct thread). Paging: with no cursor you get the newest messages; go back with beforeMessageId=oldestMessageId (or before=<ISO date>) while hasMore is true. With afterMessageId or since (and no before cursor) you get the OLDEST messages after it, and hasMore means newer ones exist: continue with afterMessageId=newestMessageId. limit defaults to ${READ_THREAD_DEFAULT_LIMIT} (max ${READ_THREAD_MAX_LIMIT}). A person's private chat with an agent, or another pair of agents' thread, is not readable from an operator connection.`,
        inputSchema: {
            threadId: z.string().optional(),
            agentId: z.string().optional().describe("Agent id or name: read your conversation with it (ignored when threadId is given)"),
            afterMessageId: z.string().optional().describe("Only messages after this one (forward paging)"),
            beforeMessageId: z.string().optional().describe("Only messages before this one (backward paging)"),
            since: z.string().optional().describe("ISO date: only messages at or after it (forward paging)"),
            before: z.string().optional().describe("ISO date: only messages before it (backward paging)"),
            limit: z.number().int().min(1).max(READ_THREAD_MAX_LIMIT).optional(),
        },
    }, async ({ threadId, agentId, afterMessageId, beforeMessageId, since, before, limit }) => {
        try {
            const targetThreadId = threadId?.trim()
                || (agentId?.trim() ? await conversationWithAgent(companyId, caller, agentId) : null);
            if (!targetThreadId) {
                return errorResult(new Error(agentId ? "No conversation with that agent yet: send_message to it first, or pass a threadId from list_threads" : "Pass threadId or agentId"));
            }
            const verdict = await mcpThreadReadVerdict(companyId, targetThreadId, caller, caller);
            if (!verdict.ok) return errorResult(new Error(verdict.error));
            const thread = verdict.thread;
            const pageSize = limit ?? READ_THREAD_DEFAULT_LIMIT;

            const lower = afterMessageId
                ? afterMessage(await threadAnchor(companyId, thread.id, afterMessageId, "afterMessageId"))
                : since ? gte(threadMessages.createdAt, parseDate(since, "since")!) : undefined;
            const upper = beforeMessageId
                ? beforeMessage(await threadAnchor(companyId, thread.id, beforeMessageId, "beforeMessageId"))
                : before ? lt(threadMessages.createdAt, parseDate(before, "before")!) : undefined;
            const forward = Boolean(lower) && !upper;

            const rows = await db.select().from(threadMessages).where(and(
                eq(threadMessages.companyId, companyId),
                eq(threadMessages.threadId, thread.id),
                conversationMessageFilter(),
                lower,
                upper,
            ))
                .orderBy(...(forward
                    ? [asc(threadMessages.createdAt), asc(threadMessages.id)]
                    : [desc(threadMessages.createdAt), desc(threadMessages.id)]))
                .limit(pageSize + 1);
            const hasMore = rows.length > pageSize;
            const page = rows.slice(0, pageSize);
            if (!forward) page.reverse();
            const messages = await toConversationMessages(companyId, page);
            return jsonResult({
                thread: { id: thread.id, type: thread.type, title: thread.title },
                messages,
                hasMore,
                hasMoreDirection: forward ? "newer" : "older",
                oldestMessageId: messages[0]?.messageId ?? null,
                newestMessageId: messages.at(-1)?.messageId ?? null,
            });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("wait_for_reply", {
        title: "Wait for Reply",
        description: `Wait for new messages in a thread that you did not send, e.g. an agent's answer after send_message. Pass threadId and afterMessageId (the messageId send_message returned), or since. Returns as soon as something arrives, oldest first (up to ${WAIT_BATCH_MAX}; call again with afterMessageId=nextAfterMessageId for more). Agents often post a short acknowledgement (ack: true) before the real answer, so keep waiting until you have it. Waits at most timeoutSeconds (default ${WAIT_DEFAULT_SECONDS}, max ${WAIT_MAX_SECONDS}); on timedOut: true just call it again. At most ${WAIT_MAX_CONCURRENT_PER_TOKEN} waits per connection at once.`,
        inputSchema: {
            threadId: z.string(),
            afterMessageId: z.string().optional().describe("Only messages after this one (same thread)"),
            since: z.string().optional().describe("ISO date: only messages after it (when there is no afterMessageId)"),
            timeoutSeconds: z.number().int().min(1).max(WAIT_MAX_SECONDS).optional(),
        },
    }, async ({ threadId, afterMessageId, since, timeoutSeconds }, extra) => {
        const open = openWaits.get(waitKey) ?? 0;
        if (open >= WAIT_MAX_CONCURRENT_PER_TOKEN) {
            return errorResult(new Error(`Too many waits at once on this connection (max ${WAIT_MAX_CONCURRENT_PER_TOKEN}): wait for a previous wait_for_reply to return, then call again.`));
        }
        openWaits.set(waitKey, open + 1);
        try {
            const verdict = await mcpThreadReadVerdict(companyId, threadId.trim(), caller, caller);
            if (!verdict.ok) return errorResult(new Error(verdict.error));
            const thread = verdict.thread;

            let cursor: SQL;
            if (afterMessageId) {
                cursor = afterMessage(await threadAnchor(companyId, thread.id, afterMessageId, "afterMessageId"));
            } else if (since) {
                const sinceDate = parseDate(since, "since")!;
                if (sinceDate.getTime() > Date.now() + FUTURE_SINCE_TOLERANCE_MS) {
                    return errorResult(new Error("since is in the future, so nothing could arrive after it: pass afterMessageId (the messageId send_message returned) or a past since."));
                }
                cursor = sql`${threadMessages.createdAt} > ${sinceDate.toISOString()}::timestamptz`;
            } else {
                // No cursor: after the caller's own latest message here, so a
                // reply that landed before this call is not missed; else from now.
                const [own] = await db.select({ id: threadMessages.id }).from(threadMessages).where(and(
                    eq(threadMessages.companyId, companyId), eq(threadMessages.threadId, thread.id), sql`NOT (${notFromCaller(caller)})`,
                )).orderBy(desc(threadMessages.createdAt), desc(threadMessages.id)).limit(1);
                cursor = own ? afterMessage(own.id) : sql`${threadMessages.createdAt} > now()`;
            }

            const conditions = and(
                eq(threadMessages.companyId, companyId),
                eq(threadMessages.threadId, thread.id),
                conversationMessageFilter(),
                notFromCaller(caller),
                cursor,
            );
            const deadline = Date.now() + (timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000;
            const signal = extra?.signal;
            while (!signal?.aborted) {
                const rows = await db.select().from(threadMessages).where(conditions)
                    .orderBy(asc(threadMessages.createdAt), asc(threadMessages.id)).limit(WAIT_BATCH_MAX);
                if (rows.length > 0) {
                    const messages = await toConversationMessages(companyId, rows);
                    return jsonResult({
                        threadId: thread.id,
                        timedOut: false,
                        messages,
                        nextAfterMessageId: messages.at(-1)!.messageId,
                        ...(messages.every((m) => m.ack) ? { hint: "Only an acknowledgement so far: call wait_for_reply again with afterMessageId=nextAfterMessageId for the answer." } : {}),
                    });
                }
                const left = deadline - Date.now();
                if (left <= 0) break;
                await sleep(Math.min(WAIT_POLL_MS, left), signal);
            }
            return jsonResult({
                threadId: thread.id,
                timedOut: true,
                messages: [],
                hint: "No new message yet. Call wait_for_reply again with the same arguments; agents can take a few minutes. read_thread shows the whole conversation.",
            });
        } catch (e) {
            return errorResult(e);
        } finally {
            const left = (openWaits.get(waitKey) ?? 1) - 1;
            if (left > 0) openWaits.set(waitKey, left);
            else openWaits.delete(waitKey);
        }
    });
}
