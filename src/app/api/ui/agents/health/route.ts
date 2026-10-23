import { NextResponse } from "next/server";
import { getScopedAgentIds } from "@/lib/member-scope";
import { computeCompanyHealth } from "@/lib/agent-health";
import { companyRouteAccess } from "@/lib/company-access";

export const dynamic = "force-dynamic";

/** Agent health for the dashboard. Restricted members only see their agents. */
export async function GET() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const agentIds = getScopedAgentIds(access.ctx.scope);
    try {
        return NextResponse.json(await computeCompanyHealth(companyId, { agentIds }), { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        console.error("[agent-health]", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
