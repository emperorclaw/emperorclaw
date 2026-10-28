import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { memberViewCaller, transferViewOwner, viewErrorResponse } from "@/lib/views";

/** Hand the view to another member who can see its scope: {ownerUserId}. Owners/admins (without opening it) or its owner. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer", { module: "views" });
    if (access.response) return access.response;
    try {
        const { id } = await params;
        const body = await req.json().catch(() => null) as Record<string, unknown> | null;
        return NextResponse.json(await transferViewOwner(access.ctx.companyId, memberViewCaller(access.ctx), id, body?.ownerUserId));
    } catch (error) {
        return viewErrorResponse(error);
    }
}
