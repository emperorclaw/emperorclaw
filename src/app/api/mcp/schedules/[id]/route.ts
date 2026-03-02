import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { schedules, playbooks } from "@/db/schema";
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
    const { id: scheduleId } = await params;
    const endpoint = `/mcp/schedules/${scheduleId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const { name, cronExpression, agentPattern, playbookId, scheduleStatus } = body;

        // Ensure we actually have something to update
        if (name === undefined && cronExpression === undefined && agentPattern === undefined && playbookId === undefined && scheduleStatus === undefined) {
            return NextResponse.json({ error: "At least one field to update must be provided" }, { status: 400 });
        }

        const [existing] = await db.select().from(schedules).where(
            and(eq(schedules.id, scheduleId), eq(schedules.companyId, companyId), isNull(schedules.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Schedule not found or unauthorized." }, { status: 404 });
        }

        const updateData: any = { updatedAt: new Date() };
        if (name !== undefined) updateData.name = name;
        if (cronExpression !== undefined) updateData.cronExpression = cronExpression;
        if (agentPattern !== undefined) updateData.agentPattern = agentPattern;
        if (scheduleStatus !== undefined) updateData.status = scheduleStatus;

        if (playbookId !== undefined) {
            // Verify playbook ownership if attempting to re-map
            if (playbookId !== null) {
                const [pb] = await db.select().from(playbooks).where(and(eq(playbooks.id, playbookId), eq(playbooks.companyId, companyId)));
                if (!pb) return NextResponse.json({ error: "RELATIONSHIP_VIOLATION", details: "playbookId not found" }, { status: 400 });
            }
            updateData.playbookId = playbookId;
        }

        const [updatedSchedule] = await db.update(schedules).set(updateData).where(eq(schedules.id, scheduleId)).returning();

        const res = { message: `Schedule ${scheduleId} updated successfully`, schedule: updatedSchedule };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error updating schedule ${scheduleId}:`, err);
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
    const { id: scheduleId } = await params;
    const endpoint = `/mcp/schedules/${scheduleId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const [existing] = await db.select().from(schedules).where(
            and(eq(schedules.id, scheduleId), eq(schedules.companyId, companyId), isNull(schedules.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Schedule not found or already deleted." }, { status: 404 });
        }

        const [deletedItem] = await db.update(schedules).set({
            deletedAt: new Date(),
        }).where(eq(schedules.id, scheduleId)).returning();

        const res = { message: `Schedule ${scheduleId} archived successfully`, schedule: deletedItem };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting schedule ${scheduleId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
