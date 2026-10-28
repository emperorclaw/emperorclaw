import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { viewRoleFor } from "@/lib/resource-access";
import { roleGte } from "@/lib/role-matrix";
import { revertView, memberViewCaller, viewErrorResponse } from "@/lib/views";

/** Members and up: bring back an earlier layout as a new version. Body {version}. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer", { module: "views" });
    if (access.response) return access.response;
    try {
        const { id } = await params;
        const role = await viewRoleFor(access.ctx, id);
        if (!role) return NextResponse.json({ error: "View not found" }, { status: 404 });
        if (!roleGte(role, "member")) return NextResponse.json({ error: "Forbidden — this action requires member access to this view's scope." }, { status: 403 });
        const body = await req.json().catch(() => null) as { version?: unknown } | null;
        const view = await revertView(access.ctx.companyId, memberViewCaller({ ...access.ctx, role }), id, body?.version);
        return NextResponse.json({ view });
    } catch (error) {
        return viewErrorResponse(error);
    }
}
