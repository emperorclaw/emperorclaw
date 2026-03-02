import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { workflowTemplates } from "@/db/schema";
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
    const { id: templateId } = await params;
    const endpoint = `/mcp/templates/${templateId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const [existing] = await db.select().from(workflowTemplates).where(
            and(eq(workflowTemplates.id, templateId), eq(workflowTemplates.companyId, companyId), isNull(workflowTemplates.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Workflow template not found or already deleted." }, { status: 404 });
        }

        const [deleted] = await db.update(workflowTemplates).set({
            deletedAt: new Date(),
        }).where(eq(workflowTemplates.id, templateId)).returning();

        const res = { message: `Workflow template ${templateId} deleted successfully`, template: deleted };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting workflow template ${templateId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
