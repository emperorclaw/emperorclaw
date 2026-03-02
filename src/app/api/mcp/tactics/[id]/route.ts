import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { tactics } from "@/db/schema";
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
    const { id: tacticId } = await params;
    const endpoint = `/mcp/tactics/${tacticId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const [existing] = await db.select().from(tactics).where(
            and(eq(tactics.id, tacticId), eq(tactics.companyId, companyId), isNull(tactics.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Tactic not found or already deleted." }, { status: 404 });
        }

        const [deleted] = await db.update(tactics).set({
            deletedAt: new Date(),
        }).where(eq(tactics.id, tacticId)).returning();

        const res = { message: `Tactic ${tacticId} deleted successfully`, tactic: deleted };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting tactic ${tacticId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
