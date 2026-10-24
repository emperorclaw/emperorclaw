import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { listProjectsForCompany, createProjectForCompany } from "@/lib/projects-crud";
import { assertMcpMayReachAgent, mcpAccessErrorResponse, mcpMayUseCustomer, mcpRouteAccess } from "@/lib/mcp-access";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const limit = parseInt(searchParams.get("limit") || "100", 10);
    const status = searchParams.get("status");
    const agentIdParam = searchParams.get("agentId");

    try {
        const scoped = await mcpRouteAccess(companyId, auth.companyToken!, agentIdParam);
        if (scoped.response) return scoped.response;
        const result = await listProjectsForCompany({ companyId, limit, status, projectIdFilter: scoped.access.allowedProjectIds });
        return NextResponse.json({ projects: result });
    } catch (err) {
        console.error("Error fetching projects:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const endpoint = "/api/mcp/projects";

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const {
            customerId,
            goal,
            description,
            status: projectStatus,
            leadAgentId = null,
            requireApprovalForDone = false,
            requireReviewBeforeDone = false,
            commentRequiredForReview = false,
            blockStatusChangesWithPendingApproval = false,
            onlyLeadCanChangeStatus = false,
            maxActiveAgents = 3,
            agentId,
        } = body;

        if (!goal) {
            return NextResponse.json({ error: "goal is required" }, { status: 400 });
        }

        const scoped = await mcpRouteAccess(companyId, auth.companyToken!, agentId);
        if (scoped.response) return scoped.response;
        if (customerId && !mcpMayUseCustomer(scoped.access, customerId)) {
            return NextResponse.json({ error: "Customer is outside this agent's scope" }, { status: 403 });
        }
        try {
            await assertMcpMayReachAgent(companyId, scoped.access, leadAgentId);
        } catch (error) {
            const denied = mcpAccessErrorResponse(error);
            if (denied) return denied;
            throw error;
        }

        const project = await createProjectForCompany({
            companyId,
            customerId,
            goal,
            description: typeof description === "string" ? description : null,
            status: projectStatus,
            leadAgentId,
            requireApprovalForDone,
            requireReviewBeforeDone,
            commentRequiredForReview,
            blockStatusChangesWithPendingApproval,
            onlyLeadCanChangeStatus,
            maxActiveAgents,
        });

        const res = { message: "Project created", project };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 201 });
    } catch (err) {
        console.error("Error creating project:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
