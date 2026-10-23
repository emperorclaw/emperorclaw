import { NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { canAdmin } from "@/lib/role-matrix";
import { loadRunThoughts } from "@/lib/dashboard-live";
import { getScopedAgentIds } from "@/lib/member-scope";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/thoughts — each working agent's live run step for the
 * living office's thought bubbles (0.9 run events only; one bounded query).
 * The dashboard polls it while "Show thoughts" is on and an agent is working,
 * between its 15 s page refreshes. Same privacy as the page: a direct chat the
 * viewer is not in, or a pair thread for a non-admin, only shows the step's
 * generic label.
 */
export async function GET() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    // Role from the DB (requireRole), not the login-time JWT claim.
    const includePairThreads = canAdmin(access.ctx.role);
    const now = new Date();
    const thoughts = await loadRunThoughts(companyId, {
        now,
        agentIds: getScopedAgentIds(access.ctx.scope),
        viewerUserId: access.ctx.userId,
        includePairThreads,
    });
    return NextResponse.json({ ts: now.toISOString(), thoughts });
}
