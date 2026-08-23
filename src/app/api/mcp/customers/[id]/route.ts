import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { loadAgentScopeContext, isCustomerAllowed } from "@/lib/agent-scope";

async function resolveScopedAgent(companyId: string, agentIdParam: unknown): Promise<
    { ok: true; allowedCustomerIds: Set<string> | null } | { ok: false; response: NextResponse }
> {
    if (typeof agentIdParam !== "string" || !agentIdParam) {
        return { ok: true, allowedCustomerIds: null };
    }
    try {
        const resolvedAgentId = await resolveAgentId(companyId, agentIdParam);
        const { allowedCustomerIds } = await loadAgentScopeContext(companyId, resolvedAgentId);
        return { ok: true, allowedCustomerIds };
    } catch {
        return { ok: false, response: NextResponse.json({ error: "Agent not found" }, { status: 404 }) };
    }
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: customerId } = await params;
    const endpoint = `/api/mcp/customers/${customerId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const { name, notes, agentId } = body;

        // Ensure we actually have something to update
        if (name === undefined && notes === undefined) {
            return NextResponse.json({ error: "At least one field (name, notes) to update must be provided" }, { status: 400 });
        }

        const [existing] = await db.select().from(customers).where(
            and(eq(customers.id, customerId), eq(customers.companyId, companyId), isNull(customers.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Customer not found or unauthorized." }, { status: 404 });
        }

        const scoped = await resolveScopedAgent(companyId, agentId);
        if (!scoped.ok) return scoped.response;
        if (!isCustomerAllowed(scoped.allowedCustomerIds, customerId)) {
            return NextResponse.json({ error: "Customer is outside this agent's scope" }, { status: 403 });
        }

        const updateData: any = {};
        if (name !== undefined) updateData.name = name;
        if (notes !== undefined) updateData.notes = notes;

        const [updatedCustomer] = await db.update(customers).set(updateData).where(eq(customers.id, customerId)).returning();

        const res = { message: `Customer ${customerId} updated successfully`, customer: updatedCustomer };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error updating customer ${customerId}:`, err);
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
    const { id: customerId } = await params;
    const endpoint = `/api/mcp/customers/${customerId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const [existing] = await db.select().from(customers).where(
            and(eq(customers.id, customerId), eq(customers.companyId, companyId), isNull(customers.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Customer not found or already deleted." }, { status: 404 });
        }

        let agentId: unknown;
        try {
            agentId = (await req.json())?.agentId;
        } catch {
            // No body / not JSON — DELETE typically has none, treat as unscoped caller.
        }
        const scoped = await resolveScopedAgent(companyId, agentId);
        if (!scoped.ok) return scoped.response;
        if (!isCustomerAllowed(scoped.allowedCustomerIds, customerId)) {
            return NextResponse.json({ error: "Customer is outside this agent's scope" }, { status: 403 });
        }

        const [deletedItem] = await db.update(customers).set({
            deletedAt: new Date(),
        }).where(eq(customers.id, customerId)).returning();

        const res = { message: `Customer ${customerId} archived successfully`, customer: deletedItem };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting customer ${customerId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
