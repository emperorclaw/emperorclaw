import { NextRequest, NextResponse } from "next/server";
import { checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { createView, listViews, viewErrorResponse } from "@/lib/views";
import { VIEW_SCOPE_TYPES, type ViewScopeType } from "@/lib/view-spec";
import { readJson, viewMcpCaller } from "./_shared";

/** list_views: the views the calling agent can see (?scopeType=&scopeId=&includeArchived=true). */
export async function GET(req: NextRequest) {
    const resolved = await viewMcpCaller(req);
    if (resolved.response) return resolved.response;
    try {
        const params = req.nextUrl.searchParams;
        const scopeType = params.get("scopeType");
        const views = await listViews(resolved.companyId, resolved.caller, {
            scopeType: (VIEW_SCOPE_TYPES as readonly string[]).includes(scopeType ?? "") ? scopeType as ViewScopeType : undefined,
            scopeId: params.get("scopeId") ?? undefined,
            includeArchived: params.get("includeArchived") === "true",
        });
        return NextResponse.json({ count: views.length, views });
    } catch (error) {
        return viewErrorResponse(error);
    }
}

/** create_view: {title, description?, scopeType?, scopeId?, panels[], threadId?, ownerUserId?, visibility?, refreshEveryMinutes?}. */
export async function POST(req: NextRequest) {
    const resolved = await viewMcpCaller(req);
    if (resolved.response) return resolved.response;
    const endpoint = "POST /api/mcp/views";
    // Bound to the caller: another token, or another agent of the same operator token, never gets this response back.
    const caller = { tokenId: resolved.tokenId, agentId: resolved.caller.kind === "agent" ? resolved.caller.access.agentId : null };
    const idempotency = await checkIdempotency(req, resolved.companyId, endpoint, caller);
    if (idempotency.error) return NextResponse.json({ error: idempotency.error }, { status: idempotency.status });
    if (idempotency.cachedResponse) return NextResponse.json(idempotency.cachedResponse);
    try {
        const body = await readJson(req);
        if (!body) return NextResponse.json({ error: "A JSON object body is required" }, { status: 400 });
        const view = await createView(resolved.companyId, resolved.caller, {
            title: body.title, description: body.description, scopeType: body.scopeType, scopeId: body.scopeId, panels: body.panels,
            threadId: body.threadId, ownerUserId: body.ownerUserId, visibility: body.visibility, refreshEveryMinutes: body.refreshEveryMinutes,
        });
        const res = { message: "View created. Keep it fresh with update_panel on a schedule.", url: `/views/${view.id}`, view };
        await saveIdempotencyResponse(resolved.companyId, endpoint, idempotency.requestHash!, JSON.parse(JSON.stringify(res)));
        return NextResponse.json(res, { status: 201 });
    } catch (error) {
        return viewErrorResponse(error);
    }
}
