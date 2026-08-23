import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { randomUUID } from "crypto";
import { eq, and, desc, isNull } from "drizzle-orm";
import { loadAgentScopeContext, scopeCondition } from "@/lib/agent-scope";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
    const agentIdParam = searchParams.get("agentId");

    try {
        let resolvedAgentId: string | null = null;
        if (agentIdParam) {
            try {
                resolvedAgentId = await resolveAgentId(companyId, agentIdParam);
            } catch {
                return NextResponse.json({ error: "Agent not found" }, { status: 404 });
            }
        }
        const { allowedCustomerIds } = await loadAgentScopeContext(companyId, resolvedAgentId);
        const conditions = [eq(customers.companyId, companyId), isNull(customers.deletedAt)];
        const scoped = scopeCondition(allowedCustomerIds, customers.id);
        if (scoped) conditions.push(scoped);

        const rows = await db.select()
            .from(customers)
            .where(and(...conditions))
            .orderBy(desc(customers.createdAt))
            .limit(limit);

        return NextResponse.json({ customers: rows });
    } catch (err) {
        console.error("Error fetching customers:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const endpoint = "/api/mcp/customers";

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const { name, notes } = body;

        if (!name) {
            return NextResponse.json({ error: "name is required" }, { status: 400 });
        }

        // Check if customer exists by name to avoid duplicates (naive approach for this example)
        let customer;
        const [existing] = await db.select().from(customers).where(
            and(eq(customers.name, name), eq(customers.companyId, companyId))
        ).limit(1);

        if (existing) {
            [customer] = await db.update(customers).set({
                notes: notes || existing.notes
            }).where(eq(customers.id, existing.id)).returning();
        } else {
            [customer] = await db.insert(customers).values({
                id: randomUUID(),
                companyId,
                name,
                notes: notes || "",
            }).returning();
        }

        const res = { message: "Customer saved", customer };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: existing ? 200 : 201 });
    } catch (err) {
        console.error("Error creating customer:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
