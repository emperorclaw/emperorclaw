import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess, outOfMemberScope } from "@/lib/company-access";
import { agentUseFor } from "@/lib/agent-access-server";
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
    // Who can use it (0.20): people who may not use a limited agent never see
    // it; owners/admins seeing it as metadata still read its safety settings.
    if ((await agentUseFor(access.ctx, id)) === "none" || !(await findCompanyAgent(access.ctx.companyId, id))) return outOfMemberScope("Agent");
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
    // Tightening an agent's permissions is a safety control: owners/admins may,
    // even on an agent they see only as metadata (it reveals none of its chats).
    const use = await agentUseFor(access.ctx, id);
    if (use === "none") return outOfMemberScope("Agent");
    const body = await req.json().catch(() => null) as { policies?: unknown } | null;
    // ...but only to tighten (off / ask first): loosening an action to
    // "allowed", or back to the company default, needs full use of the agent.
    if (use === "metadata") {
        const values = body?.policies && typeof body.policies === "object" ? Object.values(body.policies as Record<string, unknown>) : [];
        if (values.some((value) => value !== "off" && value !== "ask")) {
            return NextResponse.json({ error: "This agent is limited to other people: you can only turn its actions off or to ask first." }, { status: 403 });
        }
    }
    try {
        const maps = await updateActionPolicies({ companyId: access.ctx.companyId, agentId: id, changes: body?.policies, actorUserId: access.ctx.userId });
        return NextResponse.json({ agentPolicies: maps.agent, companyPolicies: maps.company, canEdit: true });
    } catch (error) {
        if (error instanceof ActionPolicyError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Agent action policy update failed:", error);
        return NextResponse.json({ error: "Could not save the permissions. Try again." }, { status: 500 });
    }
}
