import { NextRequest } from "next/server";
import { addGroupMembers, removeGroupMember } from "@/lib/groups";
import { announceGroup, groupRoute } from "@/lib/group-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Add members: { agentIds?, humanUserIds? }. Re-adding is a no-op. */
export async function POST(req: NextRequest, { params }: Params) {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    return groupRoute(async ({ companyId }) => {
        const group = await addGroupMembers(companyId, id, body);
        announceGroup(companyId, id, "members");
        return { group };
    });
}

/** Remove one member: { kind: "agent" | "human", id }. */
export async function DELETE(req: NextRequest, { params }: Params) {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    return groupRoute(async ({ companyId }) => {
        const group = await removeGroupMember(companyId, id, body);
        announceGroup(companyId, id, "members");
        return { group };
    });
}
