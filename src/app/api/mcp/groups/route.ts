import { NextRequest } from "next/server";
import { createGroup, listGroups } from "@/lib/groups";
import { announceGroupChange, groupMcpRoute } from "@/lib/group-mcp-route";
import { assertMcpMayAddAgents, mcpAccessForAgent } from "@/lib/mcp-access";

export const dynamic = "force-dynamic";

/** GET /api/mcp/groups[?mine=1&agentId=…] — every group, or only the acting agent's. */
export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    return groupMcpRoute(req, searchParams.get("agentId"), async ({ companyId, actor }) => {
        const mine = searchParams.get("mine") === "1" || searchParams.get("mine") === "true";
        const agentId = mine && actor.type === "agent" ? actor.id : null;
        // Pair threads are private handoffs: only the "mine" (participant) view
        // of a real agent may include them, never an operator/system token and
        // never the unscoped everything-listing.
        // A restricted agent sees no out-of-scope agents in any group's members.
        const visibleAgentIds = actor.type === "agent" ? (await mcpAccessForAgent(companyId, actor.id)).allowedAgentIds : null;
        return { groups: await listGroups(companyId, { agentId, includePairThreads: mine && actor.type === "agent", visibleAgentIds }) };
    });
}

/** POST /api/mcp/groups — { title, description?, agentIds?, humanUserIds?, agentId? }. */
export async function POST(req: NextRequest) {
    const body = await req.json().catch(() => ({}));
    return groupMcpRoute(req, body.agentId, async ({ companyId, actor }) => {
        await assertMcpMayAddAgents(companyId, actor.type === "agent" ? actor.id : null, body.agentIds ?? body.members);
        const group = await createGroup(companyId, actor, body);
        announceGroupChange(companyId, group.id, "created");
        return { group };
    }, 201);
}
