import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { viewRoleFor } from "@/lib/resource-access";
import { roleGte } from "@/lib/role-matrix";
import { deleteView, getView, memberViewCaller, setViewArchived, setViewPinned, updateView, viewErrorResponse } from "@/lib/views";

/**
 * One view with its panel values. Missing and not visible are both 404; an
 * owner/admin outside a private view gets its metadata only (access: "metadata").
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer", { module: "views" });
    if (access.response) return access.response;
    try {
        const { id } = await params;
        return NextResponse.json({ view: await getView(access.ctx.companyId, memberViewCaller(access.ctx), id, { includeArchived: true, allowMetadata: true }) });
    } catch (error) {
        return viewErrorResponse(error);
    }
}

/**
 * Members and up who can open the view: rename or describe it, set its
 * expected refresh interval, archive or restore it. `pinnedToHome` pins it to
 * the caller's own Home (also /pin). Panel values stay the agents' job
 * (update_panel); who sees it is /access, its owner /owner.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer", { module: "views" });
    if (access.response) return access.response;
    try {
        const { id } = await params;
        // Resource-aware (0.20): the caller's role on the view's customer/project.
        const role = await viewRoleFor(access.ctx, id);
        if (!role) return NextResponse.json({ error: "View not found" }, { status: 404 });
        if (!roleGte(role, "member")) return NextResponse.json({ error: "Forbidden — this action requires member access to this view's scope." }, { status: 403 });
        const body = await req.json().catch(() => null) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return NextResponse.json({ error: "A JSON object body is required" }, { status: 400 });
        const { companyId } = access.ctx;
        const caller = memberViewCaller({ ...access.ctx, role });
        // Restore first and archive last: an archived view takes no other edits.
        if (body.archived === false) await setViewArchived(companyId, caller, id, false);
        if (body.title !== undefined || body.description !== undefined || body.refreshEveryMinutes !== undefined) {
            await updateView(companyId, caller, id, { title: body.title, description: body.description, refreshEveryMinutes: body.refreshEveryMinutes });
        }
        if (typeof body.pinnedToHome === "boolean") await setViewPinned(companyId, caller, id, body.pinnedToHome);
        if (body.archived === true) await setViewArchived(companyId, caller, id, true);
        return NextResponse.json({ view: await getView(companyId, caller, id, { includeArchived: true }) });
    } catch (error) {
        return viewErrorResponse(error);
    }
}

/** Delete a view for good: owners/admins (even a private view they cannot open) and the view's owner. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer", { module: "views" });
    if (access.response) return access.response;
    try {
        const { id } = await params;
        // A resource admin deletes views inside their customer/project like a company admin.
        const role = await viewRoleFor(access.ctx, id);
        if (!role) return NextResponse.json({ error: "View not found" }, { status: 404 });
        return NextResponse.json(await deleteView(access.ctx.companyId, memberViewCaller({ ...access.ctx, role }), id));
    } catch (error) {
        return viewErrorResponse(error);
    }
}
