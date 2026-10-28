import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess, outOfMemberScope } from "@/lib/company-access";
import { memberMaySeeAgent } from "@/lib/member-scope";
import { canAdmin } from "@/lib/role-matrix";
import { ActionPolicyError, findCompanyAgent, loadActionPolicies, updateActionPolicies } from "@/lib/action-policy-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/{id}/action-policies — the agent's own action permissions
 * and the company defaults under them. Anyone who can see the agent may read
 * them; `canEdit` says whether this person may change them.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const { id } = await params;
    if (!memberMaySeeAgent(access.ctx.scope, id) || !(await findCompanyAgent(access.ctx.companyId, id))) return outOfMemberScope("Agent");
    const maps = await loadActionPolicies(access.ctx.companyId, id);
    return NextResponse.json({ agentPolicies: maps.agent, companyPolicies: maps.company, canEdit: canAdmin(access.ctx.role) });
}

/**
 * PUT /api/agents/{id}/action-policies { policies: { action: "off" | "ask" | "allowed" | null } }
 * Owners and admins only. null puts an action back on the company default.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const { id } = await params;
    // Owners and admins are never member-scoped today; checked anyway so a scoped editor can't reach a hidden agent.
    if (!memberMaySeeAgent(access.ctx.scope, id)) return outOfMemberScope("Agent");
    const body = await req.json().catch(() => null) as { policies?: unknown } | null;
    try {
        const maps = await updateActionPolicies({ companyId: access.ctx.companyId, agentId: id, changes: body?.policies, actorUserId: access.ctx.userId });
        return NextResponse.json({ agentPolicies: maps.agent, companyPolicies: maps.company, canEdit: true });
    } catch (error) {
        if (error instanceof ActionPolicyError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Agent action policy update failed:", error);
        return NextResponse.json({ error: "Could not save the permissions. Try again." }, { status: 500 });
    }
}
