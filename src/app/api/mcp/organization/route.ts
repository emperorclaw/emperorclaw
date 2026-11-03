import { NextRequest } from "next/server";
import { groupMcpRoute } from "@/lib/group-mcp-route";
import { organizationForAgent } from "@/lib/organization";

export async function GET(req: NextRequest) {
    return groupMcpRoute(req, new URL(req.url).searchParams.get("agentId"), async ({ companyId, actor }) => {
        // Bound agents receive only their own team memberships, never pair
        // threads. An agent limited to certain agents gets no names/ids of the
        // others as leaders, coordinators, managers, reports, peers or in the
        // tree (one-way: its own list).
        const organization = await organizationForAgent(companyId, actor.type === "agent" ? actor.id! : null);
        return { ...organization, consult: "GET /organization (agent-bound token) or get_organization; team details: GET /groups?mine=1" };
    });
}
