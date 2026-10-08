import { NextRequest } from "next/server";
import { groupMcpRoute } from "@/lib/group-mcp-route";
import { loadOrganization, organizationBriefing } from "@/lib/organization";
export async function GET(req: NextRequest) {
    return groupMcpRoute(req, new URL(req.url).searchParams.get("agentId"), async ({ companyId, actor }) => {
        const org = await loadOrganization(companyId);
        // Bound agents receive only their own team memberships, never pair threads.
        return { configured: org.configured, companyName: org.companyName, ...organizationBriefing(org.leader, org.teams, actor.type === "agent" ? actor.id! : "", org.config.nodes, [...org.roster.map(p => ({id:p.id,name:p.name,kind:"agent" as const})),...org.people.map(p => ({id:p.id,name:p.name,kind:"human" as const}))]), consult: "GET /organization (agent-bound token); team details: GET /groups?mine=1" };
    });
}
