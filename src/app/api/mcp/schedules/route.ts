import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { schedules, playbooks, projects, customers } from "@/db/schema";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const rawLimit = parseInt(searchParams.get("limit") || "100", 10);
    const rawPage = parseInt(searchParams.get("page") || "1", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const offset = (page - 1) * limit;

    try {
        const whereClause = and(
            eq(schedules.companyId, companyId),
            isNull(schedules.deletedAt),
        );

        const [summary] = await db.select({ total: count() })
            .from(schedules)
            .where(whereClause);

        const rows = await db.select()
            .from(schedules)
            .where(whereClause)
            .orderBy(desc(schedules.createdAt))
            .limit(limit)
            .offset(offset);

        const total = summary?.total ?? 0;

        return NextResponse.json({
            schedules: rows,
            pagination: {
                page,
                limit,
                total,
                totalPages: total === 0 ? 0 : Math.ceil(total / limit),
                hasMore: offset + rows.length < total,
            },
        });
    } catch (err) {
        console.error("Error fetching schedules:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const endpoint = "/api/mcp/schedules";

    const { requestHash, cachedResponse, error: idempError, status } = await checkIdempotency(req, companyId, endpoint);
    if (idempError) return NextResponse.json({ error: idempError }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const { name, playbookId, cronExpression, targetProjectId, targetCustomerId, nextRunAt, agentPattern, scheduleStatus = 'active' } = body;

        if (!name || !cronExpression) {
            return NextResponse.json({ error: "name and cronExpression are required" }, { status: 400 });
        }

        // Validate Relationships if provided
        if (playbookId) {
            const [pb] = await db.select().from(playbooks).where(and(eq(playbooks.id, playbookId), eq(playbooks.companyId, companyId)));
            if (!pb) return NextResponse.json({ error: "RELATIONSHIP_VIOLATION", details: "playbookId not found" }, { status: 400 });
        }
        if (targetProjectId) {
            const [proj] = await db.select().from(projects).where(and(eq(projects.id, targetProjectId), eq(projects.companyId, companyId)));
            if (!proj) return NextResponse.json({ error: "RELATIONSHIP_VIOLATION", details: "targetProjectId not found" }, { status: 400 });
        }
        if (targetCustomerId) {
            const [cust] = await db.select().from(customers).where(and(eq(customers.id, targetCustomerId), eq(customers.companyId, companyId)));
            if (!cust) return NextResponse.json({ error: "RELATIONSHIP_VIOLATION", details: "targetCustomerId not found" }, { status: 400 });
        }

        const nextRunDate = nextRunAt ? new Date(nextRunAt) : null;

        const [newSchedule] = await db.insert(schedules).values({
            id: randomUUID(),
            companyId,
            name,
            playbookId: playbookId || null,
            cronExpression,
            targetProjectId: targetProjectId || null,
            targetCustomerId: targetCustomerId || null,
            nextRunAt: nextRunDate,
            agentPattern: agentPattern || null,
            status: scheduleStatus,
        }).returning();

        const res = { message: "Schedule registered", schedule: newSchedule };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 201 });
    } catch (e: unknown) {
        console.error("Schedules POST Error:", e);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
