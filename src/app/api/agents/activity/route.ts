import { NextResponse } from "next/server";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { loadAgentActivity } from "@/lib/agent-activity";
import { getScopeFromSession, getScopedAgentIds } from "@/lib/member-scope";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/activity — what each agent is doing right now (live status
 * line, open run, claimed task, last run, last visible message). Human
 * session, scoped to the caller's company and member scope; polled by the
 * Agents page.
 */
export async function GET() {
    const session = await getValidatedServerSession();
    const companyId = session ? await getCompanyId() : null;
    if (!session || !companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const agentIds = getScopedAgentIds(getScopeFromSession(session));
    const agents = await loadAgentActivity(companyId, { viewerUserId: session.user.id ?? null, agentIds });
    return NextResponse.json({ ts: new Date().toISOString(), agents });
}
