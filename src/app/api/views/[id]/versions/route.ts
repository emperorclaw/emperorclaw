import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { listViewVersions, viewErrorResponse } from "@/lib/views";

/** A view's layout history, newest first. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    try {
        const { id } = await params;
        const versions = await listViewVersions(access.ctx.companyId, { kind: "member", userId: access.ctx.userId, scope: access.ctx.scope }, id);
        return NextResponse.json({ versions });
    } catch (error) {
        return viewErrorResponse(error);
    }
}
