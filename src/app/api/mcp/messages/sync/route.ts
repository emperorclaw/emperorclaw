import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { agents, companies, messageThreads, threadMessages } from "@/db/schema";
import { eq, and, gt, desc, sql, ne, inArray, isNull, lte } from "drizzle-orm";
import { GROUP_THREAD_TYPE, loadGroupMembers } from "@/lib/groups";
import { agentStreaks, decideDelivery, type RouteDecision } from "@/lib/message-routing";
import { touchAgentLiveness } from "@/lib/lifecycle";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const since = searchParams.get('since'); // ISO Date string
    const mode = (searchParams.get('mode') || 'human_only').toLowerCase(); // human_only | all
    const senderTypeFilter = searchParams.get('senderType'); // optional explicit sender type
    const agentId = searchParams.get('agentId'); // agent requesting sync — used for dedup + scoping
    const retryMessageIds = (searchParams.get('retryMessageIds') || '')
        .split(',').filter(id => UUID_RE.test(id)).slice(0, 100);

    const sinceDate = since ? new Date(since) : null;
    const isValidSince = sinceDate && !isNaN(sinceDate.getTime());

    // Resolve the polling agent to its canonical UUID so we can (a) exclude its
    // own messages and (b) scope delivery to the threads it actually belongs to.
    // Without scoping, every agent receives every human message in the company —
    // so a message directed at one agent gets picked up and answered by others,
    // and their replies land in the wrong direct thread (messages appear to
    // "jump" between agents' chats).
    let resolvedAgentId: string | null = null;
    if (agentId) {
        try {
            resolvedAgentId = await resolveAgentId(companyId, agentId);
        } catch {
            resolvedAgentId = UUID_RE.test(agentId) ? agentId : null;
        }
    }
    // Polling is a sign of life: a runtime syncing is not down.
    if (resolvedAgentId && UUID_RE.test(resolvedAgentId)) await touchAgentLiveness(companyId, resolvedAgentId);
    const scopeAgentId = resolvedAgentId && UUID_RE.test(resolvedAgentId) ? resolvedAgentId : null;

    const MAX_POLL_TIME_MS = 25000;
    const POLL_INTERVAL_MS = 1000;
    const startTime = Date.now();

    try {
        while (Date.now() - startTime < MAX_POLL_TIME_MS) {
            if (req.signal.aborted) break;

            const conditions: any[] = [
                eq(threadMessages.companyId, companyId),
                ne(threadMessages.deliveryState, 'cancelled'),
                sql`NOT (${threadMessages.metadataJson} ? 'runtimeControl')`,
            ];

            if (senderTypeFilter) {
                conditions.push(eq(threadMessages.senderType, senderTypeFilter));
            } else if (mode === 'human_only') {
                // Default behavior keeps existing OpenClaw directive semantics.
                conditions.push(eq(threadMessages.senderType, 'human'));
            }

            // Exclude agent's own messages from sync — prevents self-triggering loops.
            // Use SQL OR to include messages where senderId IS NULL (human-sent via MCP API).
            if (resolvedAgentId) {
                conditions.push(sql`(${threadMessages.senderId} IS NULL OR ${threadMessages.senderId} != ${resolvedAgentId})`);
            }

            // Scope delivery to threads this agent belongs to: the shared team
            // channel (everyone) plus its own direct thread. This is the fix for
            // messages "leaking" into the wrong agent's chat — an agent must only
            // receive messages addressed to it or posted in the team channel.
            // Recomputed each iteration so a direct thread created mid-poll (the
            // human's first DM provisions it) is picked up without waiting for
            // the next sync call.
            if (scopeAgentId) {
                conditions.push(sql`${threadMessages.threadId} IN (
                    SELECT id FROM message_threads
                        WHERE company_id = ${companyId}::uuid AND type = 'team' AND archived_at IS NULL
                    UNION
                    SELECT thread_id FROM thread_participants
                        WHERE company_id = ${companyId}::uuid
                          AND participant_type = 'agent'
                          AND participant_id = ${scopeAgentId}::uuid
                )`);
            }

            if (isValidSince) {
                // Safety buffer: subtract 10ms to handle sub-millisecond precision drift between servers/DBs
                const bufferDate = new Date(sinceDate.getTime() - 10);
                const sinceCondition = scopeAgentId
                    ? sql`(${threadMessages.createdAt} > ${bufferDate} OR (${threadMessages.targetAgentId} = ${scopeAgentId}::uuid AND ${threadMessages.senderType} = 'human' AND ${threadMessages.deliveryState} IN ('queued', 'seen', 'acting')))`
                    : gt(threadMessages.createdAt, bufferDate);
                // A runtime retains failed message IDs in a durable retry ledger.
                // Include only those exact messages after the normal cursor has
                // advanced, while keeping every company/thread scope above.
                conditions.push(retryMessageIds.length > 0
                    ? sql`(${sinceCondition} OR ${threadMessages.id} = ANY(ARRAY[${sql.join(retryMessageIds.map(id => sql`${id}::uuid`), sql`, `)}]))`
                    : sinceCondition);
            }

            const messages = await db.select()
                .from(threadMessages)
                .where(and(...conditions))
                .orderBy(desc(threadMessages.createdAt))
                .limit(100);

            if (messages.length > 0) {
                // Dedup: if agentId is provided, exclude messages in threads where
                // this agent already replied AFTER the trigger message. This prevents
                // the bridge from re-processing messages it already responded to,
                // even if bridge state (JSON file) was lost or corrupted.
                let filtered = messages;
                if (resolvedAgentId) {
                    const threadIds = [...new Set(messages.map(m => m.threadId).filter(Boolean))];
                    if (threadIds.length > 0) {
                        // Get the latest agent message in each of these threads
                        const agentReplies = await db
                            .select({
                                threadId: threadMessages.threadId,
                                maxCreatedAt: sql<string>`MAX(${threadMessages.createdAt})`.as('max_created_at'),
                            })
                            .from(threadMessages)
                            .where(and(
                                eq(threadMessages.companyId, companyId),
                                eq(threadMessages.senderType, 'agent'),
                                eq(threadMessages.senderId, resolvedAgentId),
                                // Only check threads we care about
                                sql`${threadMessages.threadId} = ANY(ARRAY[${sql.join(threadIds.map(id => sql`${id}::uuid`), sql`, `)}])`,
                            ))
                            .groupBy(threadMessages.threadId);
                        
                        const replyMap = new Map(agentReplies.map(r => [r.threadId, new Date(r.maxCreatedAt)]));
                        filtered = messages.filter(m => {
                            const lastReply = replyMap.get(m.threadId);
                            if (!lastReply) return true; // No reply from this agent yet
                            // A newer reply must not discard an explicitly queued direct follow-up.
                            if (m.targetAgentId === resolvedAgentId && m.senderType === 'human' && ['queued', 'seen', 'acting'].includes(m.deliveryState)) return true;
                            return m.createdAt > lastReply; // Only show messages AFTER our last reply
                        });
                    }
                }

                if (filtered.length > 0) {
                    const [comp] = await db.select({ contextNotes: companies.contextNotes }).from(companies).where(eq(companies.id, companyId));
                    // Say which kind of thread each message is in. Runtimes
                    // route on it (team/group answer only when @mentioned,
                    // direct always) and their loop guards key off it; without
                    // it every message looked type-less and those guards never
                    // engaged. Group threads also carry their purpose and
                    // members once, in `threads`, for the agent's context.
                    // Enrichment must never cost delivery: on any failure (e.g. a
                    // database not yet migrated) messages go out as before.
                    const { threadInfo, threads } = await describeThreads(companyId, filtered.map((m) => m.threadId))
                        .catch((error) => {
                            console.warn("Thread details unavailable for sync:", error instanceof Error ? error.message : error);
                            return { threadInfo: new Map<string, { type: string; title: string | null }>(), threads: {} };
                        });
                    // The server's verdict on who answers each message, so every
                    // runtime routes the same way (see lib/message-routing.ts).
                    const routing = resolvedAgentId
                        ? await routeForAgent(companyId, resolvedAgentId, filtered, threadInfo).catch((error) => {
                            console.warn("Routing verdicts unavailable for sync:", error instanceof Error ? error.message : error);
                            return null;
                        })
                        : null;
                    return NextResponse.json({
                        ok: true,
                        mode,
                        contextNotes: comp?.contextNotes || null,
                        threads,
                        messages: filtered.reverse().map((m) => ({
                            ...m,
                            threadType: threadInfo.get(m.threadId)?.type ?? null,
                            threadTitle: threadInfo.get(m.threadId)?.title ?? null,
                            ...(routing?.get(m.id) ?? {}),
                        })),
                    });
                }
            }

            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        return NextResponse.json({
            ok: true,
            mode,
            messages: []
        });
    } catch (error) {
        console.error("Failed to sync messages:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

async function describeThreads(companyId: string, threadIds: string[]) {
    const ids = [...new Set(threadIds.filter(Boolean))];
    const threadInfo = new Map<string, { type: string; title: string | null }>();
    const threads: Record<string, { id: string; type: string; title: string | null; description: string | null; members: { kind: string; id: string; name: string; role: string }[] }> = {};
    if (ids.length === 0) return { threadInfo, threads };
    const rows = await db.select({ id: messageThreads.id, type: messageThreads.type, title: messageThreads.title, description: messageThreads.description })
        .from(messageThreads)
        .where(and(eq(messageThreads.companyId, companyId), inArray(messageThreads.id, ids)));
    for (const row of rows) threadInfo.set(row.id, { type: row.type, title: row.title });
    const groupIds = rows.filter((r) => r.type === GROUP_THREAD_TYPE).map((r) => r.id);
    if (groupIds.length) {
        const members = await loadGroupMembers(companyId, groupIds);
        for (const row of rows.filter((r) => r.type === GROUP_THREAD_TYPE)) {
            threads[row.id] = {
                id: row.id,
                type: row.type,
                title: row.title,
                description: row.description,
                members: (members.get(row.id) ?? []).map(({ kind, id, name, role }) => ({ kind, id, name, role })),
            };
        }
    }
    return { threadInfo, threads };
}

/** Per-message routing verdicts for the agent that is syncing. */
async function routeForAgent(
    companyId: string,
    agentId: string,
    messages: (typeof threadMessages.$inferSelect)[],
    threadInfo: Map<string, { type: string; title: string | null }>,
): Promise<Map<string, RouteDecision>> {
    const roster = await db.select({ id: agents.id, name: agents.name }).from(agents)
        .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));

    // Consecutive-agent streaks per thread, from the recent tail of each thread.
    const streaks = new Map<string, number>();
    const byThread = new Map<string, Date>();
    for (const m of messages) {
        const latest = byThread.get(m.threadId);
        if (!latest || m.createdAt > latest) byThread.set(m.threadId, m.createdAt);
    }
    await Promise.all([...byThread.entries()].map(async ([threadId, latest]) => {
        if (threadInfo.get(threadId)?.type === "direct") return;
        const tail = await db.select({ id: threadMessages.id, senderType: threadMessages.senderType })
            .from(threadMessages)
            .where(and(eq(threadMessages.companyId, companyId), eq(threadMessages.threadId, threadId), lte(threadMessages.createdAt, latest)))
            .orderBy(desc(threadMessages.createdAt))
            .limit(200);
        for (const [id, streak] of agentStreaks(tail.reverse())) streaks.set(id, streak);
    }));

    const verdicts = new Map<string, RouteDecision>();
    for (const m of messages) {
        verdicts.set(m.id, decideDelivery({
            agentId,
            message: { senderType: m.senderType, senderId: m.senderId, targetAgentId: m.targetAgentId, text: m.text },
            threadType: threadInfo.get(m.threadId)?.type ?? null,
            roster,
            agentStreak: streaks.get(m.id) ?? 0,
        }));
    }
    return verdicts;
}
