import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { loadAgentScopeContext, isProjectAllowed, isCustomerAllowed } from "@/lib/agent-scope";

async function isArtifactOutOfScope(companyId: string, agentIdParam: unknown, artifact: { projectId: string | null; customerId: string | null }): Promise<boolean> {
    if (typeof agentIdParam !== "string" || !agentIdParam) return false;
    let resolvedAgentId: string;
    try {
        resolvedAgentId = await resolveAgentId(companyId, agentIdParam);
    } catch {
        return true;
    }
    const { allowedProjectIds, allowedCustomerIds } = await loadAgentScopeContext(companyId, resolvedAgentId);
    if (allowedProjectIds === null && allowedCustomerIds === null) return false;
    if (!artifact.projectId && !artifact.customerId) return false; // company-wide artifact
    const projectOk = artifact.projectId ? isProjectAllowed(allowedProjectIds, artifact.projectId) : false;
    const customerOk = artifact.customerId ? isCustomerAllowed(allowedCustomerIds, artifact.customerId) : false;
    return !(projectOk || customerOk);
}

export async function DELETE(
    req: NextRequest,
    context: RouteContext<"/api/mcp/artifacts/[id]">
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: artifactId } = await context.params;
    const endpoint = `/api/mcp/artifacts/${artifactId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const [existing] = await db.select().from(artifacts).where(
            and(eq(artifacts.id, artifactId), eq(artifacts.companyId, companyId), isNull(artifacts.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Artifact not found or already deleted." }, { status: 404 });
        }

        let agentId: unknown;
        try {
            agentId = (await req.json())?.agentId;
        } catch {
            // No body — DELETE typically has none, treat as unscoped caller.
        }
        if (await isArtifactOutOfScope(companyId, agentId, existing)) {
            return NextResponse.json({ error: "Artifact is outside this agent's scope" }, { status: 403 });
        }

        const [deleted] = await db.update(artifacts).set({
            deletedAt: new Date(),
        }).where(eq(artifacts.id, artifactId)).returning();

        const res = { message: `Artifact ${artifactId} deleted successfully`, artifact: deleted };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting artifact ${artifactId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
