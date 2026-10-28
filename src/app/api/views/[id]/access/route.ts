import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { listViewSharePeople, memberViewCaller, setViewVisibility, viewErrorResponse } from "@/lib/views";

/** The people the owner may share the view with (members who can see its scope). Empty for anyone but the owner. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer", { module: "views" });
    if (access.response) return access.response;
    try {
        const { id } = await params;
        return NextResponse.json({ people: await listViewSharePeople(access.ctx.companyId, memberViewCaller(access.ctx), id) });
    } catch (error) {
        return viewErrorResponse(error);
    }
}

/** The owner sets who sees the view: {visibility: "private" | "shared" | "scope", shareUserIds?: string[]}. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer", { module: "views" });
    if (access.response) return access.response;
    try {
        const { id } = await params;
        const body = await req.json().catch(() => null) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return NextResponse.json({ error: "A JSON object body is required" }, { status: 400 });
        const view = await setViewVisibility(access.ctx.companyId, memberViewCaller(access.ctx), id, { visibility: body.visibility, shareUserIds: body.shareUserIds });
        return NextResponse.json({ view });
    } catch (error) {
        return viewErrorResponse(error);
    }
}
