import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { llmPricing } from "@/db/schema";

/**
 * GET  /api/mcp/pricing — list all active pricing entries
 * POST /api/mcp/pricing — refused (see below)
 */
export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const rows = await db.select().from(llmPricing).orderBy(llmPricing.provider, llmPricing.model);
    return NextResponse.json({ pricing: rows });
}

/**
 * POST /api/mcp/pricing was removed: llm_pricing is one table shared by every
 * company on the instance, and any company token (even one bound to an agent)
 * could rewrite it, e.g. zero its own model's price to defeat its budget.
 * Pricing is edited by instance admins on Costs (POST /api/ui/pricing).
 */
export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    return NextResponse.json(
        { error: "LLM pricing is managed by an instance admin on the Costs page; it cannot be changed with an MCP token." },
        { status: 403 },
    )
}
