import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { agents, companies, messageThreads, threadMessages } from "@/db/schema";
import { eq, and, gt, asc, desc, sql, ne, inArray, isNull, lte } from "drizzle-orm";
import { SYNC_CURSOR_SLACK_MS, SYNC_PAGE_SIZE, selectSyncPage } from "@/lib/sync-page";
import { GROUP_THREAD_TYPE, isAgentPairThread, loadGroupMembers, pairThreadPurpose } from "@/lib/groups";
import { agentMessageWakesAgent, agentStreaks, agentLoopMaxTurnsFor, AGENT_LOOP_COOLDOWN_MS, answeredCutoffByThread, decideDelivery, filterAnsweredMessages, isLoopGuardResume, noteProgressResets, type RouteDecision } from "@/lib/message-routing";
import { touchAgentLiveness } from "@/lib/lifecycle";
import { progressTimestampsForThread } from "@/lib/control-plane";
import { recordInterestingVerdicts, type VerdictRecord } from "@/lib/run-ledger";
import { privateThreadsHiddenFromToken } from "@/lib/thread-access";
import { BOUND_AGENT_MISMATCH, mcpAccessForAgent, mcpThreadIdCondition } from "@/lib/mcp-access";

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
    // Bridge 0.9: ids it already holds; they never end the long poll by themselves (lib/sync-page.ts).
    const knownIds = (searchParams.get('knownIds') || '')
        .split(',').filter(id => UUID_RE.test(id)).slice(0, 200);

    const sinceDate = since ? new Date(since) : null;
    const isValidSince = sinceDate && !isNaN(sinceDate.getTime());

    // Resolve the polling agent to its canonical UUID so we can (a) exclude its
    // own messages and (b) scope delivery to the threads it actually belongs to.
    // Without scoping, every agent receives every human message in the company —
    // so a message directed at one agent gets picked up and answered by others,
    // and their replies land in the wrong direct thread (messages appear to
    // "jump" between agents' chats).
    // A bound token always syncs as its own agent: it can neither name
    // another agent (and receive that agent's threads) nor omit the agent to
    // get the unscoped company-wide stream.
    const boundAgentId = auth.companyToken!.agentId || null;
    let resolvedAgentId: string | null = boundAgentId;
    if (agentId) {
        try {
            resolvedAgentId = await resolveAgentId(companyId, agentId);
        } catch {
            resolvedAgentId = UUID_RE.test(agentId) ? agentId : null;
        }
        if (boundAgentId && resolvedAgentId !== boundAgentId) {
            return NextResponse.json({ error: BOUND_AGENT_MISMATCH }, { status: 403 });
        }
    }
    // Polling is a sign of life: a runtime syncing is not down.
    if (resolvedAgentId && UUID_RE.test(resolvedAgentId)) await touchAgentLiveness(companyId, resolvedAgentId);
    const scopeAgentId = resolvedAgentId && UUID_RE.test(resolvedAgentId) ? resolvedAgentId : null;
    // Project/task threads outside the agent's data scope never reach it.
    const threadScope = mcpThreadIdCondition(companyId, await mcpAccessForAgent(companyId, scopeAgentId), threadMessages.threadId);

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
                sql`NOT (${threadMessages.metadataJson} ? 'runtimeGoalRequest')`,
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
            // channel (everyone) plus every direct thread it is in — its shared
            // (Operations) thread and, in private direct-chat mode, each
            // person's own thread with it. This is the fix for
            // messages "leaking" into the wrong agent's chat — an agent must only
            // receive messages addressed to it or posted in the team channel.
            // Recomputed each iteration so a direct thread created mid-poll (the
            // human's first DM provisions it) is picked up without waiting for
            // the next sync call.
            // A person's private direct thread reaches only a token bound to its
            // own agent: never a company-wide token, whatever agentId it names.
            conditions.push(privateThreadsHiddenFromToken(companyId, auth.companyToken!.agentId ?? null));
            if (threadScope) conditions.push(threadScope);

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
                const bufferDate = new Date(sinceDate.getTime() - SYNC_CURSOR_SLACK_MS);
                const sinceCondition = scopeAgentId
                    ? sql`(${gt(threadMessages.createdAt, bufferDate)} OR (${threadMessages.targetAgentId} = ${scopeAgentId}::uuid AND ${threadMessages.senderType} IN ('human', 'system') AND ${threadMessages.deliveryState} IN ('queued', 'seen', 'acting')))`
                    : gt(threadMessages.createdAt, bufferDate);
                // A runtime retains failed message IDs in a durable retry ledger.
                // Include only those exact messages after the normal cursor has
                // advanced, while keeping every company/thread scope above.
                conditions.push(retryMessageIds.length > 0
                    ? sql`(${sinceCondition} OR ${threadMessages.id} = ANY(ARRAY[${sql.join(retryMessageIds.map(id => sql`${id}::uuid`), sql`, `)}]))`
                    : sinceCondition);
            }

            // Oldest first after the cursor, one row more than a page to detect `hasMore` (M7).
            const rows = await db.select()
                .from(threadMessages)
                .where(and(...conditions))
                .orderBy(asc(threadMessages.createdAt), asc(threadMessages.id))
                .limit(SYNC_PAGE_SIZE + 1);
            const { page: messages, hasMore, hasNew, nextSince } = selectSyncPage(rows, {
                since: isValidSince ? sinceDate : null,
                retryIds: retryMessageIds,
                knownIds,
            });

            if (messages.length > 0) {
                // Dedup: if agentId is provided, exclude messages in threads where
                // this agent already replied AFTER the trigger message. This prevents
                // the bridge from re-processing messages it already responded to,
                // even if bridge state (JSON file) was lost or corrupted.
                let filtered = messages;
                if (resolvedAgentId) {
                    const threadIds = [...new Set(messages.map(m => m.threadId).filter(Boolean))];
                    if (threadIds.length > 0) {
                        // This agent's replies in these threads, each with the
                        // message it answered (runtimes set `replyToMessageId`).
                        // The replied-to message's own createdAt is the "answered
                        // up to" cutoff — NOT the reply's createdAt. A runtime is
                        // serial, so a message that arrived while it was busy
                        // answering an earlier one falls between that earlier
                        // message and the reply; keying on the reply's instant
                        // wrongly marked it answered and dropped it.
                        const agentReplies = await db
                            .select({
                                threadId: threadMessages.threadId,
                                createdAt: threadMessages.createdAt,
                                replyToId: sql<string | null>`${threadMessages.metadataJson}->>'replyToMessageId'`,
                                // Acknowledgements answer nothing; see answeredCutoffByThread.
                                isAck: sql<boolean>`coalesce(${threadMessages.metadataJson}->>'ack' = 'true', false)`,
                            })
                            .from(threadMessages)
                            .where(and(
                                eq(threadMessages.companyId, companyId),
                                eq(threadMessages.senderType, 'agent'),
                                eq(threadMessages.senderId, resolvedAgentId),
                                inArray(threadMessages.threadId, threadIds),
                            ));

                        const answeredIds = [...new Set(
                            agentReplies.map(r => r.replyToId).filter((id): id is string => !!id && UUID_RE.test(id)),
                        )];
                        const answeredAtById = new Map<string, Date>();
                        if (answeredIds.length > 0) {
                            const answers = await db
                                .select({ id: threadMessages.id, createdAt: threadMessages.createdAt })
                                .from(threadMessages)
                                .where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.id, answeredIds)));
                            for (const a of answers) answeredAtById.set(a.id, a.createdAt);
                        }

                        const cutoff = answeredCutoffByThread(agentReplies, answeredAtById);
                        filtered = filterAnsweredMessages(messages, cutoff, resolvedAgentId);
                    }
                }

                // Always-included open messages alone do not end the long poll (lib/sync-page.ts):
                // they go out with the next new message, or on the poll's last iteration so a
                // runtime still recovers them.
                const lastIteration = Date.now() - startTime + POLL_INTERVAL_MS >= MAX_POLL_TIME_MS;
                if (filtered.length === 0 && hasMore) {
                    // A whole page was already answered: hand back the cursor at once so the
                    // runtime moves on to the next page instead of holding 25 s on this one.
                    return NextResponse.json({ ok: true, mode, messages: [], hasMore, nextSince });
                }
                if (filtered.length > 0 && (hasNew || lastIteration)) {
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
                            return { threadInfo: new Map<string, { type: string; title: string | null; description: string | null; isAgentPair: boolean }>(), threads: {} };
                        });
                    // The server's verdict on who answers each message, so every
                    // runtime routes the same way (see lib/message-routing.ts).
                    const routing = resolvedAgentId
                        ? await routeForAgent(companyId, resolvedAgentId, filtered, threadInfo).catch((error) => {
                            console.warn("Routing verdicts unavailable for sync:", error instanceof Error ? error.message : error);
                            return null;
                        })
                        : null;
                    // Best-effort: store the verdicts that explain delivery for
                    // the inspector. Never let a ledger failure break or slow
                    // the sync response.
                    if (routing && routing.verdicts.length > 0) {
                        // Fire-and-forget: persisting verdicts must never add
                        // latency to the sync hot path. A failure is logged only —
                        // the routing response was already computed above.
                        void recordInterestingVerdicts(companyId, routing.verdicts).catch((error) => {
                            console.warn("Verdict logging failed:", error instanceof Error ? error.message : error);
                        });
                    }
                    return NextResponse.json({
                        ok: true,
                        mode,
                        contextNotes: comp?.contextNotes || null,
                        threads,
                        hasMore,
                        nextSince,
                        messages: filtered.map((m) => ({
                            ...m,
                            threadType: threadInfo.get(m.threadId)?.type ?? null,
                            threadTitle: threadInfo.get(m.threadId)?.title ?? null,
                            isAgentPair: threadInfo.get(m.threadId)?.isAgentPair ?? false,
                            ...(routing?.decisions.get(m.id) ?? {}),
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
    const threadInfo = new Map<string, { type: string; title: string | null; description: string | null; isAgentPair: boolean }>();
    const threads: Record<string, { id: string; type: string; title: string | null; description: string | null; members: { kind: string; id: string; name: string; role: string }[] }> = {};
    if (ids.length === 0) return { threadInfo, threads };
    const rows = await db.select({ id: messageThreads.id, type: messageThreads.type, title: messageThreads.title, description: messageThreads.description, createdByType: messageThreads.createdByType })
        .from(messageThreads)
        .where(and(eq(messageThreads.companyId, companyId), inArray(messageThreads.id, ids)));
    for (const row of rows) threadInfo.set(row.id, { type: row.type, title: row.title, description: row.description, isAgentPair: isAgentPairThread(row) });
    const groupIds = rows.filter((r) => r.type === GROUP_THREAD_TYPE).map((r) => r.id);
    if (groupIds.length) {
        const members = await loadGroupMembers(companyId, groupIds);
        for (const row of rows.filter((r) => r.type === GROUP_THREAD_TYPE)) {
            const rowMembers = members.get(row.id) ?? [];
            // Never expose the raw "agent-pair" marker as the purpose: give the
            // agent a readable description while keeping the isAgentPair flag.
            const description = isAgentPairThread(row) ? pairThreadPurpose(rowMembers) : row.description;
            threads[row.id] = {
                id: row.id,
                type: row.type,
                title: row.title,
                description,
                members: rowMembers.map(({ kind, id, name, role }) => ({ kind, id, name, role })),
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
    threadInfo: Map<string, { type: string; title: string | null; description: string | null; isAgentPair: boolean }>,
): Promise<{ decisions: Map<string, RouteDecision>; verdicts: VerdictRecord[] }> {
    const roster = await db.select({ id: agents.id, name: agents.name }).from(agents)
        .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));

    // Consecutive-agent streaks per thread, from the recent tail of each thread.
    // Progress (task state changes, notes, artifacts) by the thread's agent
    // participants resets the streak, so cooperative work never trips the guard.
    const streaks = new Map<string, number>();
    const byThread = new Map<string, Date>();
    for (const m of messages) {
        const latest = byThread.get(m.threadId);
        if (!latest || m.createdAt > latest) byThread.set(m.threadId, m.createdAt);
    }
    await Promise.all([...byThread.entries()].map(async ([threadId, latest]) => {
        if (threadInfo.get(threadId)?.type === "direct") return;
        const tail = await db.select({ id: threadMessages.id, senderType: threadMessages.senderType, senderId: threadMessages.senderId, targetAgentId: threadMessages.targetAgentId, text: threadMessages.text, createdAt: threadMessages.createdAt, metadataJson: threadMessages.metadataJson })
            .from(threadMessages)
            .where(and(eq(threadMessages.companyId, companyId), eq(threadMessages.threadId, threadId), lte(threadMessages.createdAt, latest)))
            .orderBy(desc(threadMessages.createdAt))
            .limit(200);
        const ordered = tail.reverse();
        const since = new Date((ordered[0]?.createdAt.getTime() ?? latest.getTime()) - AGENT_LOOP_COOLDOWN_MS);
        const { core, notes } = await progressTimestampsForThread(companyId, threadId, since);
        // Only agent messages that wake another agent count toward the streak:
        // a status broadcast that addresses nobody cannot form a loop.
        const isAgentPair = Boolean(threadInfo.get(threadId)?.isAgentPair);
        const msgs = ordered.map((m) => ({
            id: m.id,
            senderType: m.senderType,
            createdAt: m.createdAt,
            resumes: isLoopGuardResume(m.metadataJson),
            wakesAgent: m.senderType.toLowerCase() === "agent" ? agentMessageWakesAgent(m, roster, isAgentPair) : undefined,
        }));
        for (const [id, streak] of agentStreaks(msgs, [...core, ...noteProgressResets(msgs, notes)])) streaks.set(id, streak);
    }));

    const decisions = new Map<string, RouteDecision>();
    const verdicts: VerdictRecord[] = [];
    for (const m of messages) {
        const info = threadInfo.get(m.threadId);
        const metadata = (m.metadataJson && typeof m.metadataJson === "object" ? m.metadataJson : {}) as Record<string, unknown>;
        const agentStreak = streaks.get(m.id) ?? 0;
        const maxTurns = agentLoopMaxTurnsFor(Boolean(info?.isAgentPair));
        const decision = decideDelivery({
            agentId,
            message: { senderType: m.senderType, senderId: m.senderId, targetAgentId: m.targetAgentId, text: m.text },
            threadType: info?.type ?? null,
            roster,
            agentStreak,
            maxAgentTurns: maxTurns,
            isAgentPair: info?.isAgentPair ?? false,
            taskAssignedWake: metadata.taskAssigned === true,
        });
        decisions.set(m.id, decision);
        verdicts.push({
            messageId: m.id,
            agentId,
            addressed: decision.addressedToYou,
            routeReason: decision.routeReason,
            agentStreak,
            maxTurns,
        });
    }
    return { decisions, verdicts };
}
