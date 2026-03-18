import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { agentIntegrations, agents } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> } // In Next.js 15, params is a Promise
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: agentId } = await params;

    try {
        // Verify agent exists and belongs to company
        const [existingAgent] = await db.select().from(agents).where(
            and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))
        ).limit(1);

        if (!existingAgent) {
            return NextResponse.json({ error: "Agent not found or unauthorized." }, { status: 404 });
        }

        // Fetch integrations
        const activeIntegrations = await db.select().from(agentIntegrations).where(
            and(
                eq(agentIntegrations.agentId, agentId),
                eq(agentIntegrations.companyId, companyId),
                eq(agentIntegrations.status, 'active')
            )
        );

        return NextResponse.json({ integrations: activeIntegrations }, { status: 200 });

    } catch (err) {
        console.error(`Error fetching integrations for agent ${agentId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
