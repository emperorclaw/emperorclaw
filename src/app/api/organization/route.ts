import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireRole } from "@/lib/roles";
import { GroupError } from "@/lib/groups";
import { saveOrganization } from "@/lib/organization";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { humanActor, recordAudit } from "@/lib/audit";
export async function PATCH(req: NextRequest) {
    try {
        // Reporting instructions affect every agent, so editing is admin-only.
        const ctx = await requireRole("admin")();
        const body = await req.json().catch(() => null);
        const config = await saveOrganization(ctx.companyId, body, body?.initialize === true);
        await recordAudit({ companyId: ctx.companyId, actor: humanActor(ctx.userId), action: "organization.updated", target: { type: "organization", id: ctx.companyId }, after: { leaderKind: config.leader?.kind ?? null, leaderId: config.leader?.id ?? null, nodeCount: config.nodes?.length ?? 0, teamCount: config.teamIds.length } });
        await broadcastMcpEvent(ctx.companyId, { type: "organization_updated", actorUserId: ctx.userId });
        return NextResponse.json({ config });
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        if (error instanceof GroupError) return NextResponse.json({ error: error.message }, { status: error.status });
        return NextResponse.json({ error: "Could not save organization" }, { status: 500 });
    }
}
