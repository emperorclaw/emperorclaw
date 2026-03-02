import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
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
    const { id: artifactId } = await params;
    const endpoint = `/mcp/artifacts/${artifactId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const [existing] = await db.select().from(artifacts).where(
            and(eq(artifacts.id, artifactId), eq(artifacts.companyId, companyId), isNull(artifacts.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Artifact not found or already deleted." }, { status: 404 });
        }

        const [deleted] = await db.update(artifacts).set({
            deletedAt: new Date(),
        }).where(eq(artifacts.id, artifactId)).returning();

        const res = { message: `Artifact ${artifactId} deleted successfully`, artifact: deleted };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting artifact ${artifactId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
