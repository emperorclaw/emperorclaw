import { NextRequest } from "next/server";
import { addGroupMembers, removeGroupMember } from "@/lib/groups";
import { announceGroupChange, groupMcpRoute } from "@/lib/group-mcp-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** { agentIds?, humanUserIds?, agentId? } */
export async function POST(req: NextRequest, { params }: Params) {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    return groupMcpRoute(req, body.agentId, async ({ companyId, requireMember }) => {
        await requireMember(id);
        const group = await addGroupMembers(companyId, id, body);
        announceGroupChange(companyId, id, "members");
        return { group };
    });
}

/** { kind: "agent" | "human", id, agentId? } */
export async function DELETE(req: NextRequest, { params }: Params) {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    return groupMcpRoute(req, body.agentId, async ({ companyId, requireMember }) => {
        await requireMember(id);
        const group = await removeGroupMember(companyId, id, { kind: body.kind, id: body.memberId ?? body.id });
        announceGroupChange(companyId, id, "members");
        return { group };
    });
}
