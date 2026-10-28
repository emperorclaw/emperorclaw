import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { canAdmin } from "@/lib/role-matrix";
import { ActionPolicyError, loadActionPolicies, updateActionPolicies } from "@/lib/action-policy-server";

export const dynamic = "force-dynamic";

/** GET /api/action-policies — the company's default action permissions (every agent starts from these). */
export async function GET() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const maps = await loadActionPolicies(access.ctx.companyId, null);
    return NextResponse.json({ companyPolicies: maps.company, canEdit: canAdmin(access.ctx.role) });
}

/**
 * PUT /api/action-policies { policies: { action: "off" | "ask" | "allowed" | null } }
 * Owners and admins only. null puts an action back on the built-in default.
 */
export async function PUT(req: NextRequest) {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const body = await req.json().catch(() => null) as { policies?: unknown } | null;
    try {
        const maps = await updateActionPolicies({ companyId: access.ctx.companyId, agentId: null, changes: body?.policies, actorUserId: access.ctx.userId });
        return NextResponse.json({ companyPolicies: maps.company, canEdit: true });
    } catch (error) {
        if (error instanceof ActionPolicyError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Company action policy update failed:", error);
        return NextResponse.json({ error: "Could not save the permissions. Try again." }, { status: 500 });
    }
}
