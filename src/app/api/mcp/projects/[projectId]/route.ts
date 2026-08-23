import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { updateProjectForCompany } from "@/lib/projects-crud";
import { loadAgentScopeContext, isProjectAllowed } from "@/lib/agent-scope";

async function checkAgentScopeOrForbidden(companyId: string, agentId: unknown, projectId: string): Promise<NextResponse | null> {
    if (typeof agentId !== "string" || !agentId) return null;
    let resolvedAgentId: string;
    try {
        resolvedAgentId = await resolveAgentId(companyId, agentId);
    } catch {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    const { allowedProjectIds } = await loadAgentScopeContext(companyId, resolvedAgentId);
    if (!isProjectAllowed(allowedProjectIds, projectId)) {
        return NextResponse.json({ error: "Project is outside this agent's scope" }, { status: 403 });
    }
    return null;
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ projectId: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { projectId } = await params;
    const endpoint = `/api/mcp/projects/${projectId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const {
            status: newStatus,
            goal,
            customerId,
            leadAgentId,
            requireApprovalForDone,
            requireReviewBeforeDone,
            commentRequiredForReview,
            blockStatusChangesWithPendingApproval,
            onlyLeadCanChangeStatus,
            maxActiveAgents,
            agentId,
        } = body;

        const [existing] = await db.select().from(projects).where(
            and(eq(projects.id, projectId), eq(projects.companyId, companyId), isNull(projects.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Project not found or unauthorized." }, { status: 404 });
        }

        const scopeDenied = await checkAgentScopeOrForbidden(companyId, agentId, projectId);
        if (scopeDenied) return scopeDenied;

        let project;
        try {
            project = await updateProjectForCompany({
                companyId,
                projectId,
                status: newStatus,
                goal,
                customerId,
                leadAgentId,
                requireApprovalForDone,
                requireReviewBeforeDone,
                commentRequiredForReview,
                blockStatusChangesWithPendingApproval,
                onlyLeadCanChangeStatus,
                maxActiveAgents,
            });
        } catch (e) {
            if (e instanceof Error && e.message.startsWith("INVALID_STATUS")) {
                return NextResponse.json({ error: e.message.replace("INVALID_STATUS: ", "Invalid status. Must be one of: ") }, { status: 400 });
            }
            throw e;
        }

        const res = { message: "Project updated", project };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error updating project ${projectId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ projectId: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { projectId } = await params;
    const endpoint = `/api/mcp/projects/${projectId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const [existing] = await db.select().from(projects).where(
            and(eq(projects.id, projectId), eq(projects.companyId, companyId), isNull(projects.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Project not found or already deleted." }, { status: 404 });
        }

        let agentId: unknown;
        try {
            agentId = (await req.json())?.agentId;
        } catch {
            // No body — DELETE typically has none, treat as unscoped caller.
        }
        const scopeDenied = await checkAgentScopeOrForbidden(companyId, agentId, projectId);
        if (scopeDenied) return scopeDenied;

        const [deleted] = await db.update(projects).set({
            deletedAt: new Date(),
        }).where(eq(projects.id, projectId)).returning();

        const res = { message: `Project ${projectId} soft-deleted successfully`, project: deleted };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting project ${projectId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
