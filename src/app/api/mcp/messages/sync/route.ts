import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { chatMessages, companies } from "@/db/schema";
import { eq, and, gt, desc } from "drizzle-orm";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const since = searchParams.get('since'); // ISO Date string

    const sinceDate = since ? new Date(since) : null;
    const isValidSince = sinceDate && !isNaN(sinceDate.getTime());

    const MAX_POLL_TIME_MS = 25000;
    const POLL_INTERVAL_MS = 1000;
    const startTime = Date.now();

    try {
        while (Date.now() - startTime < MAX_POLL_TIME_MS) {
            if (req.signal.aborted) break;

            let conditions: any[] = [
                eq(chatMessages.companyId, companyId),
                eq(chatMessages.senderType, 'human') // OpenClaw only needs to pull human directives
            ];

            if (isValidSince) {
                conditions.push(gt(chatMessages.createdAt, sinceDate));
            }

            const messages = await db.select()
                .from(chatMessages)
                .where(and(...conditions))
                .orderBy(desc(chatMessages.createdAt))
                .limit(100);

            if (messages.length > 0) {
                const [comp] = await db.select({ contextNotes: companies.contextNotes }).from(companies).where(eq(companies.id, companyId));

                return NextResponse.json({
                    ok: true,
                    contextNotes: comp?.contextNotes || null,
                    messages: messages.reverse() // Return chronological order
                });
            }

            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        return NextResponse.json({
            ok: true,
            messages: []
        });
    } catch (error) {
        console.error("Failed to sync messages:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
