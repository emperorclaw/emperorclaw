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
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 2000) : 200;
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

        // Check for existing schedule with same name and company to prevent duplication
        const [existing] = await db.select().from(schedules).where(
            and(
                eq(schedules.companyId, companyId), 
                eq(schedules.name, name),
                isNull(schedules.deletedAt)
            )
        ).limit(1);

        let registeredSchedule;
        if (existing) {
            // Update existing instead of creating a new one (UPSERT behavior)
            const [updated] = await db.update(schedules).set({
                cronExpression,
                playbookId: playbookId || existing.playbookId,
                targetProjectId: targetProjectId || existing.targetProjectId,
                targetCustomerId: targetCustomerId || existing.targetCustomerId,
                nextRunAt: nextRunDate || existing.nextRunAt,
                agentPattern: agentPattern || existing.agentPattern,
                status: scheduleStatus,
                updatedAt: new Date()
            }).where(eq(schedules.id, existing.id)).returning();
            registeredSchedule = updated;
        } else {
            // Insert new
            const [inserted] = await db.insert(schedules).values({
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
            registeredSchedule = inserted;
        }

        const res = { 
            message: existing ? "Schedule updated" : "Schedule registered", 
            schedule: registeredSchedule 
        };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 201 });
    } catch (e: unknown) {
        console.error("Schedules POST Error:", e);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
