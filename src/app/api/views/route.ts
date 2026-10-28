import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { createView, listViews, viewErrorResponse } from "@/lib/views";

/** The views the signed-in person may see (a restricted member: company views and their customers'/projects'). */
export async function GET(req: NextRequest) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    try {
        const views = await listViews(access.ctx.companyId, { kind: "member", userId: access.ctx.userId, scope: access.ctx.scope }, {
            includeArchived: req.nextUrl.searchParams.get("includeArchived") === "true",
        });
        return NextResponse.json({ views });
    } catch (error) {
        return viewErrorResponse(error);
    }
}

/**
 * A person starts a view (members and up): title, description and scope. An
 * agent then fills in the panels; people can also pass a full panel list.
 */
export async function POST(req: NextRequest) {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    try {
        const body = await req.json().catch(() => null) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return NextResponse.json({ error: "A JSON object body is required" }, { status: 400 });
        const view = await createView(access.ctx.companyId, { kind: "member", userId: access.ctx.userId, scope: access.ctx.scope }, {
            title: body.title, description: body.description, scopeType: body.scopeType, scopeId: body.scopeId, panels: body.panels ?? [],
        });
        return NextResponse.json({ view }, { status: 201 });
    } catch (error) {
        return viewErrorResponse(error);
    }
}
