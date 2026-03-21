import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { incidents } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: incidentId } = await params;
    const endpoint = `/api/mcp/incidents/${incidentId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const { status: nextStatus, summary, recommendedActionJson } = body;

        if (!nextStatus) {
            return NextResponse.json({ error: "status is required" }, { status: 400 });
        }

        const validStatuses = ["open", "acknowledged", "resolved"];
        if (!validStatuses.includes(nextStatus)) {
            return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` }, { status: 400 });
        }

        const [existing] = await db.select().from(incidents).where(
            and(eq(incidents.id, incidentId), eq(incidents.companyId, companyId), isNull(incidents.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Incident not found." }, { status: 404 });
        }

        const [updated] = await db.update(incidents).set({
            status: nextStatus,
            summary: summary ?? existing.summary,
            recommendedActionJson: recommendedActionJson ?? existing.recommendedActionJson,
            resolvedAt: nextStatus === "resolved" ? new Date() : null,
        }).where(eq(incidents.id, incidentId)).returning();

        await broadcastMcpEvent(companyId, { type: "incident_updated", incident: updated });

        const res = { message: `Incident ${incidentId} updated successfully`, incident: updated };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });
    } catch (err) {
        console.error(`Error updating incident ${incidentId}:`, err);
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
    const { id: incidentId } = await params;
    const endpoint = `/api/mcp/incidents/${incidentId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const [existing] = await db.select().from(incidents).where(
            and(eq(incidents.id, incidentId), eq(incidents.companyId, companyId), isNull(incidents.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Incident not found or already deleted." }, { status: 404 });
        }

        const [deleted] = await db.update(incidents).set({
            deletedAt: new Date(),
        }).where(eq(incidents.id, incidentId)).returning();

        await broadcastMcpEvent(companyId, { type: "incident_deleted", incidentId: deleted.id });

        const res = { message: `Incident ${incidentId} deleted successfully`, incident: deleted };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting incident ${incidentId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
