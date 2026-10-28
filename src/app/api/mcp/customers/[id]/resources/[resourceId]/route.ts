import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { mcpMayUseCustomer, mcpRouteAccess } from "@/lib/mcp-access";
import { archiveScopedResource, getScopedResource, resolveResourceScope, toPublicResource, updateScopedResource } from "@/lib/resources";
import { moduleGuard } from "@/lib/modules-server";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; resourceId: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const moduleOff = await moduleGuard(companyId, "customers");
    if (moduleOff) return moduleOff;
    const { id, resourceId } = await params;
    const resource = await getScopedResource(companyId, resourceId);

    if (!resource || resource.scopeType !== "customer" || resource.scopeId !== id) {
        return NextResponse.json({ error: "Scoped resource not found" }, { status: 404 });
    }
    const scoped = await mcpRouteAccess(companyId, auth.companyToken!, req.nextUrl.searchParams.get("agentId"));
    if (scoped.response) return scoped.response;
    if (!mcpMayUseCustomer(scoped.access, id)) {
        return NextResponse.json({ error: "Scoped resource not found" }, { status: 404 });
    }

    try {
        const body = await req.json();
        const updated = await updateScopedResource({
            companyId,
            resourceId,
            patch: body,
        });
        return NextResponse.json({ resource: updated ? { ...toPublicResource(updated), ...resolveResourceScope(updated) } : updated });
    } catch (routeError) {
        const message = routeError instanceof Error ? routeError.message : "Internal Server Error";
        const routeStatus = message.startsWith("Scoped resource not found") ? 404 : 400;
        return NextResponse.json({ error: message }, { status: routeStatus });
    }
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; resourceId: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const moduleOff = await moduleGuard(companyId, "customers");
    if (moduleOff) return moduleOff;
    const { id, resourceId } = await params;
    const resource = await getScopedResource(companyId, resourceId);

    if (!resource || resource.scopeType !== "customer" || resource.scopeId !== id) {
        return NextResponse.json({ error: "Scoped resource not found" }, { status: 404 });
    }
    const scoped = await mcpRouteAccess(companyId, auth.companyToken!, req.nextUrl.searchParams.get("agentId"));
    if (scoped.response) return scoped.response;
    if (!mcpMayUseCustomer(scoped.access, id)) {
        return NextResponse.json({ error: "Scoped resource not found" }, { status: 404 });
    }

    const archived = await archiveScopedResource(companyId, resourceId);
    return NextResponse.json({ resource: archived ? { ...toPublicResource(archived), ...resolveResourceScope(archived) } : archived });
}
