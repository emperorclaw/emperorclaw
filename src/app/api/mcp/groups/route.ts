import { NextRequest } from "next/server";
import { createGroup, listGroups } from "@/lib/groups";
import { announceGroupChange, groupMcpRoute } from "@/lib/group-mcp-route";

export const dynamic = "force-dynamic";

/** GET /api/mcp/groups[?mine=1&agentId=…] — every group, or only the acting agent's. */
export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    return groupMcpRoute(req, searchParams.get("agentId"), async ({ companyId, actor }) => {
        const mine = searchParams.get("mine") === "1" || searchParams.get("mine") === "true";
        return { groups: await listGroups(companyId, { agentId: mine && actor.type === "agent" ? actor.id : null }) };
    });
}

/** POST /api/mcp/groups — { title, description?, agentIds?, humanUserIds?, agentId? }. */
export async function POST(req: NextRequest) {
    const body = await req.json().catch(() => ({}));
    return groupMcpRoute(req, body.agentId, async ({ companyId, actor }) => {
        const group = await createGroup(companyId, actor, body);
        announceGroupChange(companyId, group.id, "created");
        return { group };
    }, 201);
}
