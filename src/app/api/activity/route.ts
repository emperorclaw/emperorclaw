import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLE, companyRouteAccess } from "@/lib/company-access";
import { listActivity, parseActivityQuery } from "@/lib/audit-reads";

export const dynamic = "force-dynamic";

/**
 * GET /api/activity — the company's activity / audit log, newest first.
 * Owners and admins only (members and viewers get 403).
 * Query: cursor, limit (1-100, default 50), actorType (human|agent|system),
 * actorId, targetType, from, to (ISO dates).
 */
export async function GET(req: NextRequest) {
    const access = await companyRouteAccess(ADMIN_ROLE);
    if (access.response) return access.response;
    const parsed = parseActivityQuery(req.nextUrl.searchParams);
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    try {
        return NextResponse.json(await listActivity(access.ctx.companyId, parsed.filter, parsed.cursor, parsed.limit));
    } catch (error) {
        console.error("Activity list error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
