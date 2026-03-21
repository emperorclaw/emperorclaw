import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { incidents } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";
import { broadcastMcpEvent } from "@/lib/pubsub";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const companyId = await getCompanyId();
    if (!companyId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { id } = await params;
        const body = await req.json();
        const { status } = body;

        if (!status) {
            return NextResponse.json({ error: "status is required" }, { status: 400 });
        }

        const validStatuses = ["open", "acknowledged", "resolved"];
        if (!validStatuses.includes(status)) {
            return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` }, { status: 400 });
        }

        const [existing] = await db.select().from(incidents).where(
            and(eq(incidents.id, id), eq(incidents.companyId, companyId), isNull(incidents.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Incident not found" }, { status: 404 });
        }

        const [updated] = await db.update(incidents).set({
            status,
            resolvedAt: status === "resolved" ? new Date() : null,
        }).where(eq(incidents.id, id)).returning();

        await broadcastMcpEvent(companyId, { type: "incident_updated", incident: updated });

        return NextResponse.json({ incident: updated });
    } catch (error) {
        console.error("Incident update error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
