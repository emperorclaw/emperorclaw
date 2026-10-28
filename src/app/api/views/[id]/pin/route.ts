import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { memberViewCaller, setViewPinned, viewErrorResponse } from "@/lib/views";

/** Pin the view to the caller's own Home (any role that can open it). */
export async function PUT(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer", { module: "views" });
    if (access.response) return access.response;
    try {
        const { id } = await params;
        return NextResponse.json(await setViewPinned(access.ctx.companyId, memberViewCaller(access.ctx), id, true));
    } catch (error) {
        return viewErrorResponse(error);
    }
}

/** Unpin it from the caller's Home. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer", { module: "views" });
    if (access.response) return access.response;
    try {
        const { id } = await params;
        return NextResponse.json(await setViewPinned(access.ctx.companyId, memberViewCaller(access.ctx), id, false));
    } catch (error) {
        return viewErrorResponse(error);
    }
}
