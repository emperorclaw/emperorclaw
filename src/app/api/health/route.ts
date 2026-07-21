import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import pkg from "@/../package.json" assert { type: "json" };

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/health — unauthenticated liveness/readiness probe.
 *
 * Returns 200 when the app is up and the database is reachable, 503 otherwise.
 * Safe for Docker/orchestrator healthchecks and uptime monitors: it exposes
 * only version + DB reachability, no secrets or tenant data.
 */
export async function GET() {
    let dbOk = false;
    try {
        await db.execute(sql`SELECT 1`);
        dbOk = true;
    } catch {
        dbOk = false;
    }

    const body = {
        status: dbOk ? "ok" : "degraded",
        version: pkg.version,
        checks: { database: dbOk ? "ok" : "unreachable" },
    };

    return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}
