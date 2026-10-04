import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { AuthError, requireRole } from "@/lib/roles";
import { localClock, normalizeRoutine, reviewCompany } from "@/lib/agent-routines";

export const dynamic = "force-dynamic";

function failure(error: unknown) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    console.error("[agent-routine]", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}

/** The company's daily agent review settings (defaults when never saved). */
export async function GET() {
    try {
        const { companyId } = await requireRole("member")();
        const [row] = await db.select({ routine: companies.agentRoutineJson, lastRunOn: companies.agentRoutineLastRunOn }).from(companies).where(eq(companies.id, companyId)).limit(1);
        return NextResponse.json({ routine: normalizeRoutine(row?.routine), lastRunOn: row?.lastRunOn ?? null, configured: Boolean(row?.routine) });
    } catch (error) {
        return failure(error);
    }
}

/** Admins change it: { enabled?, time?, timezone?, weekdaysOnly? }. */
export async function PUT(req: NextRequest) {
    try {
        const { companyId } = await requireRole("admin")();
        const body = await req.json().catch(() => ({}));
        const [row] = await db.select({ routine: companies.agentRoutineJson }).from(companies).where(eq(companies.id, companyId)).limit(1);
        const routine = normalizeRoutine({ ...normalizeRoutine(row?.routine), ...body });
        // Saving a time that already passed today shouldn't fire immediately:
        // the new schedule starts with the next occurrence.
        const today = localClock(new Date(), routine.timezone);
        const lastRunOn = today.time >= routine.time ? today.date : undefined;
        await db.update(companies).set({ agentRoutineJson: routine, ...(lastRunOn ? { agentRoutineLastRunOn: lastRunOn } : {}) }).where(eq(companies.id, companyId));
        return NextResponse.json({ ok: true, routine });
    } catch (error) {
        return failure(error);
    }
}

/** "Send now": run today's review immediately (admins), e.g. to see what agents get. */
export async function POST() {
    try {
        const { companyId } = await requireRole("admin")();
        const sent = await reviewCompany(companyId);
        return NextResponse.json({ ok: true, agentsReviewed: sent });
    } catch (error) {
        return failure(error);
    }
}
