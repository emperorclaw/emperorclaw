import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { AgentAccessError, agentUseFor, loadAgentAccessInfo, membersWhoCanSeeAgent, setAgentAccess } from "@/lib/agent-access-server";
import { roleGte } from "@/lib/role-matrix";

/**
 * Who can use this agent (lib/agent-access.ts), mirroring /api/views/[id]/access
 * and /owner: GET the current setting (and, for those who may change it, the
 * members who could be picked); PUT {access, userIds?, ownerUserId?}. Its
 * owner, owners and admins change it; an admin never lets themselves in.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const { id } = await params;
    const use = await agentUseFor(access.ctx, id);
    const info = use === "none" ? null : await loadAgentAccessInfo(access.ctx.companyId, id);
    if (!info) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    const canManage = roleGte(access.ctx.role, "admin") || info.owner?.id === access.ctx.userId;
    return NextResponse.json({
        ...info,
        use,
        canManage,
        candidates: canManage ? await membersWhoCanSeeAgent(access.ctx.companyId, id) : [],
    });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const { id } = await params;
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "A JSON object body is required" }, { status: 400 });
    try {
        const info = await setAgentAccess(access.ctx, id, { access: body.access, userIds: body.userIds, ownerUserId: body.ownerUserId });
        return NextResponse.json(info);
    } catch (error) {
        if (error instanceof AgentAccessError) return NextResponse.json({ error: error.message }, { status: error.status });
        throw error;
    }
}
