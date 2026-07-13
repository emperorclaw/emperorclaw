import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { companies, threadMessages } from "@/db/schema";
import { eq, and, gt, desc } from "drizzle-orm";

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
                // To avoid duplicate delivery caused by our 10ms safety buffer,
                // we filter out any message that the client has ALREADY seen by looking for the explicit 'since' string if applicable.
                // Note: The client normally sends the last message's createdAt.
                // We'll filter based on ID or exact timestamp if we had it, but for now we filter strictly on the client's provided date.
                const filtered = messages.filter(m => m.createdAt.toISOString() !== since);

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
