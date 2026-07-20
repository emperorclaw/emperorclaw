import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

const reportSchema = z.object({
    agentId: z.string().min(1),
    tokensUsed: z.number().int().min(0),
});

/**
 * POST /api/mcp/agents/report-usage
 *
 * Lightweight endpoint for bridges to report token usage.
 * Accepts {agentId, tokensUsed} and increments the agent's monthly_token_usage.
 * This is the MCP equivalent of PATCH /api/agents/[id].
 */
export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;

    try {
        const body = await req.json();
        const parsed = reportSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json({ error: "agentId and tokensUsed are required" }, { status: 400 });
        }

        const { agentId, tokensUsed } = parsed.data;

        // Increment token usage atomically
        const [updated] = await db
            .update(agents)
            .set({
                monthlyTokenUsage: sql`COALESCE(monthly_token_usage, 0) + ${tokensUsed}`,
            })
            .where(
                and(
                    eq(agents.id, agentId),
                    eq(agents.companyId, companyId),
                    isNull(agents.deletedAt),
                ),
            )
            .returning({ id: agents.id, monthlyTokenUsage: agents.monthlyTokenUsage });

        if (!updated) {
            return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        }

        return NextResponse.json({
            ok: true,
            agentId: updated.id,
            monthlyTokenUsage: updated.monthlyTokenUsage,
        });
    } catch (error) {
        console.error("report-usage error:", error);
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
}
