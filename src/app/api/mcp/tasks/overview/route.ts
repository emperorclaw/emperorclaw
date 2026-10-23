import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { getTaskOverviewForCompany } from "@/lib/openclaw/tasks";
import { mcpMayUseProject, mcpRouteAccess } from "@/lib/mcp-access";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId") || undefined;
    const requestedMax = Number.parseInt(searchParams.get("maxItems") || "10", 10);
    const maxItems = Number.isFinite(requestedMax) ? Math.min(Math.max(requestedMax, 1), 25) : 10;

    try {
        const scoped = await mcpRouteAccess(auth.companyToken!.companyId, auth.companyToken!, searchParams.get("agentId"));
        if (scoped.response) return scoped.response;
        if (projectId && !mcpMayUseProject(scoped.access, projectId)) {
            return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }
        const overview = await getTaskOverviewForCompany({
            companyId: auth.companyToken!.companyId,
            projectId,
            maxItems,
            projectIdFilter: scoped.access.allowedProjectIds,
        });
        return NextResponse.json({ overview });
    } catch (error) {
        const details = error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json({ error: "Unable to build task overview", details }, { status: 500 });
    }
}
