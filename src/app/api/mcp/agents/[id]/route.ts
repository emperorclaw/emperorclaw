import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: agentId } = await params;
    const endpoint = `/mcp/agents/${agentId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const [existing] = await db.select().from(agents).where(
            and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Agent not found or already deleted." }, { status: 404 });
        }

        const [deleted] = await db.update(agents).set({
            deletedAt: new Date(),
        }).where(eq(agents.id, agentId)).returning();

        const res = { message: `Agent ${agentId} deleted successfully`, agent: deleted };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting agent ${agentId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
