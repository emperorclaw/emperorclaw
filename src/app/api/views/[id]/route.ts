import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { getView, setViewArchived, setViewPinned, updateView, viewErrorResponse, type ViewCaller } from "@/lib/views";

/** One view with its panel values. Out-of-scope and missing are both 404. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    try {
        const { id } = await params;
        const caller: ViewCaller = { kind: "member", userId: access.ctx.userId, scope: access.ctx.scope };
        return NextResponse.json({ view: await getView(access.ctx.companyId, caller, id, { includeArchived: true }) });
    } catch (error) {
        return viewErrorResponse(error);
    }
}

/**
 * Members and up: rename or describe a view, pin it to Home, archive or
 * restore it. Panel values stay the agents' job (update_panel).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    try {
        const { id } = await params;
        const body = await req.json().catch(() => null) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return NextResponse.json({ error: "A JSON object body is required" }, { status: 400 });
        const { companyId } = access.ctx;
        const caller: ViewCaller = { kind: "member", userId: access.ctx.userId, scope: access.ctx.scope };
        // Restore first and archive last: an archived view takes no other edits.
        if (body.archived === false) await setViewArchived(companyId, caller, id, false);
        if (body.title !== undefined || body.description !== undefined) {
            await updateView(companyId, caller, id, { title: body.title, description: body.description });
        }
        if (typeof body.pinnedToHome === "boolean") await setViewPinned(companyId, caller, id, body.pinnedToHome);
        if (body.archived === true) await setViewArchived(companyId, caller, id, true);
        return NextResponse.json({ view: await getView(companyId, caller, id, { includeArchived: true }) });
    } catch (error) {
        return viewErrorResponse(error);
    }
}
