import { NextResponse } from "next/server";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { getScopeFromSession, getScopedAgentIds } from "@/lib/member-scope";
import { computeCompanyHealth } from "@/lib/agent-health";

export const dynamic = "force-dynamic";

/** Agent health for the dashboard. Restricted members only see their agents. */
export async function GET() {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const session = await getValidatedServerSession();
    const agentIds = session ? getScopedAgentIds(getScopeFromSession(session)) : undefined;
    try {
        return NextResponse.json(await computeCompanyHealth(companyId, { agentIds }), { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        console.error("[agent-health]", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
