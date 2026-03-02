import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";

export async function PATCH(
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
        const body = await req.json();
        const { role, skillsJson, modelPolicyJson, concurrencyLimit, avatarUrl } = body;

        // Ensure we actually have something to update
        if (role === undefined && skillsJson === undefined && modelPolicyJson === undefined && concurrencyLimit === undefined && avatarUrl === undefined) {
            return NextResponse.json({ error: "At least one field to update must be provided" }, { status: 400 });
        }

        const [existing] = await db.select().from(agents).where(
            and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Agent not found or unauthorized." }, { status: 404 });
        }

        const updateData: any = {};
        if (role !== undefined) updateData.role = role;
        if (skillsJson !== undefined) updateData.skillsJson = skillsJson;
        if (modelPolicyJson !== undefined) updateData.modelPolicyJson = modelPolicyJson;
        if (concurrencyLimit !== undefined) updateData.concurrencyLimit = concurrencyLimit;
        if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl;

        // We do not update name or currentLoad here; name is immutable after creation via MCP, and load is managed by the system.

        const [updatedAgent] = await db.update(agents).set(updateData).where(eq(agents.id, agentId)).returning();

        const res = { message: `Agent ${agentId} updated successfully`, agent: updatedAgent };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error updating agent ${agentId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

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

        const [deletedItem] = await db.update(agents).set({
            deletedAt: new Date(),
        }).where(eq(agents.id, agentId)).returning();

        const res = { message: `Agent ${agentId} archived successfully`, agent: deletedItem };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting agent ${agentId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
