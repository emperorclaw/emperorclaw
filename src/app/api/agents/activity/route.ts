import { NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { loadAgentActivity } from "@/lib/agent-activity";
import { getScopedAgentIds } from "@/lib/member-scope";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/activity — what each agent is doing right now (live status
 * line, open run, claimed task, last run, last visible message). Human
 * session, scoped to the caller's company and member scope; polled by the
 * Agents page.
 */
export async function GET() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    const agentIds = getScopedAgentIds(access.ctx.scope);
    const agents = await loadAgentActivity(companyId, { viewerUserId: access.ctx.userId, agentIds, scope: access.ctx.scope });
    return NextResponse.json({ ts: new Date().toISOString(), agents });
}
