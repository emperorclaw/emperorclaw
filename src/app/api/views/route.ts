import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { createView, listViews, memberViewCaller, viewErrorResponse } from "@/lib/views";
import { VIEW_SCOPE_TYPES, type ViewScopeType } from "@/lib/view-spec";

/**
 * The views the signed-in person may see (lib/view-access.ts): those open to
 * their scope, their own and those shared with them; owners/admins also get
 * the other private views as metadata only (access: "metadata").
 * ?scopeType=&scopeId= narrows to one scope, ?customer=<id> to a customer and
 * its projects, ?pinned=true to their Home pins.
 */
export async function GET(req: NextRequest) {
    const access = await companyRouteAccess("viewer", { module: "views" });
    if (access.response) return access.response;
    try {
        const params = req.nextUrl.searchParams;
        const scopeType = params.get("scopeType");
        const views = await listViews(access.ctx.companyId, memberViewCaller(access.ctx), {
            includeArchived: params.get("includeArchived") === "true",
            scopeType: (VIEW_SCOPE_TYPES as readonly string[]).includes(scopeType ?? "") ? scopeType as ViewScopeType : undefined,
            scopeId: params.get("scopeId") ?? undefined,
            customerTree: params.get("customer") ?? undefined,
            pinnedOnly: params.get("pinned") === "true",
        });
        return NextResponse.json({ views });
    } catch (error) {
        return viewErrorResponse(error);
    }
}

/**
 * A person starts a view (members and up): title, description, scope and
 * visibility (private, the default, or scope). They are its owner. An agent
 * then fills in the panels; people can also pass a full panel list.
 */
export async function POST(req: NextRequest) {
    const access = await companyRouteAccess("member", { module: "views" });
    if (access.response) return access.response;
    try {
        const body = await req.json().catch(() => null) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return NextResponse.json({ error: "A JSON object body is required" }, { status: 400 });
        const view = await createView(access.ctx.companyId, memberViewCaller(access.ctx), {
            title: body.title, description: body.description, scopeType: body.scopeType, scopeId: body.scopeId, panels: body.panels ?? [],
            visibility: body.visibility, refreshEveryMinutes: body.refreshEveryMinutes,
        });
        return NextResponse.json({ view }, { status: 201 });
    } catch (error) {
        return viewErrorResponse(error);
    }
}
