import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { verifyMcpToken } from "@/lib/mcp";
import { requireProjectInScope } from "@/lib/agent-scope";
import { archiveScopedResource, getScopedResource, resolveResourceScope, toPublicResource, updateScopedResource } from "@/lib/resources";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ projectId: string; resourceId: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { projectId, resourceId } = await params;
    const projectScopeDenied = await requireProjectInScope(req, companyId, projectId, auth.companyToken!);
    if (projectScopeDenied) return projectScopeDenied;

    const [project] = await db.select({ id: projects.id }).from(projects).where(and(
        eq(projects.companyId, companyId),
        eq(projects.id, projectId),
        isNull(projects.deletedAt),
    )).limit(1);

    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const resource = await getScopedResource(companyId, resourceId);
    if (!resource || resource.scopeType !== "project" || resource.scopeId !== projectId) {
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
    { params }: { params: Promise<{ projectId: string; resourceId: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { projectId, resourceId } = await params;
    const projectScopeDenied = await requireProjectInScope(req, companyId, projectId, auth.companyToken!);
    if (projectScopeDenied) return projectScopeDenied;
    const resource = await getScopedResource(companyId, resourceId);

    if (!resource || resource.scopeType !== "project" || resource.scopeId !== projectId) {
        return NextResponse.json({ error: "Scoped resource not found" }, { status: 404 });
    }

    const archived = await archiveScopedResource(companyId, resourceId);
    return NextResponse.json({ resource: archived ? { ...toPublicResource(archived), ...resolveResourceScope(archived) } : archived });
}
