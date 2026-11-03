import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireRole } from "@/lib/roles";
import { GroupError } from "@/lib/groups";
import { attachTeamToOrganization } from "@/lib/organization";
import { scheduleOrganizationNoteRefresh } from "@/lib/organization-note-schedule";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { humanActor, recordAudit } from "@/lib/audit";

/**
 * Add a group to the org chart as a team (setup wizard, easy setup). Only
 * adds: an edited chart keeps every node. onChart: false when the team cannot
 * be placed (then it is set up in Agents → Organization).
 */
export async function POST(req: NextRequest) {
    try {
        // Reporting instructions affect every agent, so editing is admin-only.
        const ctx = await requireRole("admin")();
        const body = await req.json().catch(() => null);
        const teamId = typeof body?.teamId === "string" ? body.teamId : "";
        if (!teamId) return NextResponse.json({ error: "teamId is required" }, { status: 400 });
        const rootAgentId = typeof body?.rootAgentId === "string" ? body.rootAgentId : null;
        // placeMeOnTop: when this starts the chart, the person setting it up sits above the AI leader.
        const result = await attachTeamToOrganization(ctx.companyId, teamId, { rootAgentId, rootHumanId: body?.placeMeOnTop === true ? ctx.userId : null });
        if (result.changed && result.config) {
            const config = result.config;
            scheduleOrganizationNoteRefresh(ctx.companyId);
            // The chart is saved: a failed audit row or broadcast must not turn that into an error.
            try {
                await recordAudit({ companyId: ctx.companyId, actor: humanActor(ctx.userId), action: "organization.updated", target: { type: "organization", id: ctx.companyId }, after: { leaderKind: config.leader?.kind ?? null, leaderId: config.leader?.id ?? null, nodeCount: config.nodes?.length ?? 0, teamCount: config.teamIds.length } });
                await broadcastMcpEvent(ctx.companyId, { type: "organization_updated", actorUserId: ctx.userId });
            } catch (error) {
                console.warn("[organization] audit/broadcast after adding a team failed:", error instanceof Error ? error.message : error);
            }
        }
        return NextResponse.json(result);
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        if (error instanceof GroupError) return NextResponse.json({ error: error.message }, { status: error.status });
        return NextResponse.json({ error: "Could not update the organization chart" }, { status: 500 });
    }
}
