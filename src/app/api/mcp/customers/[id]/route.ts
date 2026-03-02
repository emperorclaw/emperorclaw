import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { customers } from "@/db/schema";
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
    const { id: customerId } = await params;
    const endpoint = `/mcp/customers/${customerId}`;

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

        const [deleted] = await db.update(customers).set({
            deletedAt: new Date(),
        }).where(eq(customers.id, customerId)).returning();

        const res = { message: `Customer ${customerId} deleted successfully`, customer: deleted };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting customer ${customerId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
