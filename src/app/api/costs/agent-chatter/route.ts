import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { loadAgentChatter } from "@/lib/cost-brake-store";

/**
 * GET /api/costs/agent-chatter[?days=14]
 *
 * Read-only: agent-to-agent chatter per agent pair over the last `days` days
 * (default 14, max 90) — runs woken by another agent, their tokens, reported
 * cents, tokens of runs that moved nothing, and the cost brake's shadow
 * would-brake decisions. Owners/admins only: the rows span every agent and
 * thread of the company, so a restricted member's scope cannot be applied.
 */
export async function GET(req: NextRequest) {
    const access = await companyRouteAccess("admin", { module: "costs" });
    if (access.response) return access.response;
    const raw = req.nextUrl.searchParams.get("days");
    const days = raw === null ? 14 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
        return NextResponse.json({ error: "days must be an integer from 1 to 90" }, { status: 400 });
    }
    const report = await loadAgentChatter(access.ctx.companyId, { days });
    return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
}
