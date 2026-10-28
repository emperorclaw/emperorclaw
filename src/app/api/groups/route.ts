import { NextRequest } from "next/server";
import { createGroup, listGroupsForUser } from "@/lib/groups";
import { announceGroup, groupRoute, memberMaySeeGroup, requireAgentsInScope, requireAgentsUsable } from "@/lib/group-route";

export const dynamic = "force-dynamic";

/** Groups for the Messages sidebar, with this user's unread counts. */
export async function GET() {
    return groupRoute(async ({ companyId, userId, scope }) => ({ groups: (await listGroupsForUser(companyId, userId)).filter((g) => memberMaySeeGroup(scope, g)) }));
}

/** Create a group: { title, description?, agentIds?, humanUserIds? }. The creator joins it. */
export async function POST(req: NextRequest) {
    const body = await req.json().catch(() => ({}));
    return groupRoute(async ({ companyId, userId, scope, role }) => {
        requireAgentsInScope(scope, body.agentIds ?? body.members);
        await requireAgentsUsable({ companyId, userId, scope, role }, body.agentIds ?? body.members);
        const group = await createGroup(companyId, { type: "human", id: userId }, body, { requestId: body.requestId });
        announceGroup(companyId, group.id, "created");
        return { group };
    }, 201);
}
