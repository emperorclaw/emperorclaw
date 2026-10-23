import { NextResponse } from "next/server";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { loadRunThoughts } from "@/lib/dashboard-live";
import { getScopeFromSession, getScopedAgentIds } from "@/lib/member-scope";

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
    const session = await getValidatedServerSession();
    const companyId = session ? await getCompanyId() : null;
    if (!session || !companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const instanceRole = session.user.instanceRole ?? "member";
    const companyRole = session.user.companyRole ?? null;
    const includePairThreads = instanceRole === "instance_admin" || companyRole === "owner" || companyRole === "admin";
    const now = new Date();
    const thoughts = await loadRunThoughts(companyId, {
        now,
        agentIds: getScopedAgentIds(getScopeFromSession(session)),
        viewerUserId: session.user.id ?? null,
        includePairThreads,
    });
    return NextResponse.json({ ts: now.toISOString(), thoughts });
}
