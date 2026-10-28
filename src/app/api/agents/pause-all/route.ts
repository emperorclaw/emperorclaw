import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { parsePauseAllBody, setAllAgentsPaused } from "@/lib/pause-all";

export const dynamic = "force-dynamic";

/**
 * POST /api/agents/pause-all { paused: boolean } — pause (or resume) every
 * agent the caller can see, owners and admins only. Each agent goes through
 * the single-agent pause (budgetStatus) and gets its own activity entry.
 * Returns { changed: id[], unchanged: id[] }.
 */
export async function POST(req: NextRequest) {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const parsed = parsePauseAllBody(await req.json().catch(() => null));
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    try {
        const result = await setAllAgentsPaused(
            { companyId: access.ctx.companyId, userId: access.ctx.userId, scope: access.ctx.scope },
            parsed.paused,
        );
        return NextResponse.json({ paused: parsed.paused, ...result });
    } catch (error) {
        console.error("Pause all agents failed:", error);
        return NextResponse.json({ error: "Could not update every agent. Refresh to see which ones changed, then try again." }, { status: 500 });
    }
}
