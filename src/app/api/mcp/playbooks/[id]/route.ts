import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { playbooks } from "@/db/schema";
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
    const { id: playbookId } = await params;
    const endpoint = `/api/mcp/playbooks/${playbookId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const [existing] = await db.select().from(playbooks).where(
            and(eq(playbooks.id, playbookId), eq(playbooks.companyId, companyId), isNull(playbooks.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Playbook not found or already deleted." }, { status: 404 });
        }

        const [deletedItem] = await db.update(playbooks).set({
            deletedAt: new Date(),
        }).where(eq(playbooks.id, playbookId)).returning();

        const res = { message: `Playbook ${playbookId} archived successfully`, playbook: deletedItem };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting playbook ${playbookId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
