import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { viewRoleFor } from "@/lib/resource-access";
import { listViewMaintainerAgents, memberViewCaller, setViewMaintainer, viewErrorResponse } from "@/lib/views";

/**
 * The agents this person may make the view's maintainer (live agents they may
 * work with whose scope covers the view's scope) and the current one. Empty
 * for anyone who may not choose it (lib/view-access.ts mayChangeMaintainer).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer", { module: "views" });
    if (access.response) return access.response;
    try {
        const { id } = await params;
        const role = await viewRoleFor(access.ctx, id);
        if (!role) return NextResponse.json({ error: "View not found" }, { status: 404 });
        return NextResponse.json(await listViewMaintainerAgents(access.ctx.companyId, memberViewCaller({ ...access.ctx, role }), id));
    } catch (error) {
        return viewErrorResponse(error);
    }
}

/**
 * Choose, change or clear the agent that keeps the view up to date:
 * {agentId: string | null}. The view's owner, or an owner/admin who can open
 * it; never an agent (agents call /api/mcp/**, not this route).
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer", { module: "views" });
    if (access.response) return access.response;
    try {
        const { id } = await params;
        // A resource admin chooses maintainers inside their customer/project like a company admin.
        const role = await viewRoleFor(access.ctx, id);
        if (!role) return NextResponse.json({ error: "View not found" }, { status: 404 });
        const body = await req.json().catch(() => null) as Record<string, unknown> | null;
        if (!body || typeof body !== "object" || !("agentId" in body)) {
            return NextResponse.json({ error: "agentId (an agent id, or null for no maintainer) is required" }, { status: 400 });
        }
        const view = await setViewMaintainer(access.ctx.companyId, memberViewCaller({ ...access.ctx, role }), id, body.agentId);
        return NextResponse.json({ view });
    } catch (error) {
        return viewErrorResponse(error);
    }
}
