import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { HostJobError, retryAgentProvision } from "@/lib/runtime-hosts/agent-jobs";
import { serializeJob } from "@/lib/runtime-hosts/store";

/**
 * POST /api/agents/[id]/provision: retry the agent's failed setup on its
 * runtime host (0.22). A new provision job; its token is minted when the job
 * is sent and every token of the earlier attempts is revoked. Owners/admins
 * only (the job is audited).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("admin");
    if (access.response) return access.response;
    const { id } = await params;
    try {
        const job = await retryAgentProvision(access.ctx.companyId, access.ctx.userId, id);
        return NextResponse.json({ job: serializeJob(job), jobId: job.id }, { status: 201 });
    } catch (error) {
        if (error instanceof HostJobError) return NextResponse.json({ error: error.message }, { status: error.status });
        throw error;
    }
}
