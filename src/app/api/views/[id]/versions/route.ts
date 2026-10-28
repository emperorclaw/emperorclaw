import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { listViewVersions, memberViewCaller, viewErrorResponse } from "@/lib/views";

/** A view's layout history, newest first. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer", { module: "views" });
    if (access.response) return access.response;
    try {
        const { id } = await params;
        const versions = await listViewVersions(access.ctx.companyId, memberViewCaller(access.ctx), id);
        return NextResponse.json({ versions });
    } catch (error) {
        return viewErrorResponse(error);
    }
}
