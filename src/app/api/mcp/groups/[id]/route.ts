import { NextRequest } from "next/server";
import { archiveGroup, getGroup, updateGroup } from "@/lib/groups";
import { announceGroupChange, groupMcpRoute } from "@/lib/group-mcp-route";
import { mcpAccessForAgent } from "@/lib/mcp-access";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
    const { id } = await params;
    return groupMcpRoute(req, new URL(req.url).searchParams.get("agentId"), async ({ companyId, actor }) => {
        const visibleAgentIds = actor.type === "agent" ? (await mcpAccessForAgent(companyId, actor.id)).allowedAgentIds : null;
        return { group: await getGroup(companyId, id, actor, { visibleAgentIds }) };
    });
}

export async function PATCH(req: NextRequest, { params }: Params) {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    return groupMcpRoute(req, body.agentId, async ({ companyId, requireMember }) => {
        await requireMember(id);
        const group = await updateGroup(companyId, id, body);
        announceGroupChange(companyId, id, "updated");
        return { group };
    }, 200, body);
}

export async function DELETE(req: NextRequest, { params }: Params) {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    return groupMcpRoute(req, body.agentId, async ({ companyId, requireMember }) => {
        await requireMember(id);
        await archiveGroup(companyId, id);
        announceGroupChange(companyId, id, "archived");
        return { ok: true };
    }, 200, body);
}
