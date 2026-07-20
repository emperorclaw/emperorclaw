import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { companies, threadMessages } from "@/db/schema";
import { eq, and, gt, desc, sql, ne } from "drizzle-orm";

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
    const agentId = searchParams.get('agentId'); // agent requesting sync — used for dedup

    const sinceDate = since ? new Date(since) : null;
    const isValidSince = sinceDate && !isNaN(sinceDate.getTime());

    const MAX_POLL_TIME_MS = 25000;
    const POLL_INTERVAL_MS = 1000;
    const startTime = Date.now();

    try {
        while (Date.now() - startTime < MAX_POLL_TIME_MS) {
            if (req.signal.aborted) break;

            const conditions: any[] = [
                eq(threadMessages.companyId, companyId),
            ];

            if (senderTypeFilter) {
                conditions.push(eq(threadMessages.senderType, senderTypeFilter));
            } else if (mode === 'human_only') {
                // Default behavior keeps existing OpenClaw directive semantics.
                conditions.push(eq(threadMessages.senderType, 'human'));
            }

            // Exclude agent's own messages from sync — prevents self-triggering loops.
            // Use SQL OR to include messages where senderId IS NULL (human-sent via MCP API).
            if (agentId) {
                conditions.push(sql`(${threadMessages.senderId} IS NULL OR ${threadMessages.senderId} != ${agentId})`);
            }

            if (isValidSince) {
                // Safety buffer: subtract 10ms to handle sub-millisecond precision drift between servers/DBs
                const bufferDate = new Date(sinceDate.getTime() - 10);
                conditions.push(gt(threadMessages.createdAt, bufferDate));
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
                if (agentId) {
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
                                eq(threadMessages.senderId, agentId),
                                // Only check threads we care about
                                sql`${threadMessages.threadId} = ANY(ARRAY[${sql.join(threadIds.map(id => sql`${id}::uuid`), sql`, `)}])`,
                            ))
                            .groupBy(threadMessages.threadId);
                        
                        const replyMap = new Map(agentReplies.map(r => [r.threadId, new Date(r.maxCreatedAt)]));
                        filtered = messages.filter(m => {
                            const lastReply = replyMap.get(m.threadId);
                            if (!lastReply) return true; // No reply from this agent yet
                            return m.createdAt > lastReply; // Only show messages AFTER our last reply
                        });
                    }
                }

                if (filtered.length > 0) {
                    const [comp] = await db.select({ contextNotes: companies.contextNotes }).from(companies).where(eq(companies.id, companyId));
                    return NextResponse.json({
                        ok: true,
                        mode,
                        contextNotes: comp?.contextNotes || null,
                        messages: filtered.reverse()
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
