import { NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { getScopedAgentIds } from "@/lib/member-scope";
import { loadRunningRuns } from "@/lib/agent-activity";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/agents/[id]/running — the agent's running runs across all of its
 * threads, privacy-resolved for the viewer (another person's private thread and
 * out-of-scope tasks are never revealed). Powers the direct chat's
 * "Also working on" row.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid agent id" }, { status: 400 });

    const scopedAgentIds = getScopedAgentIds(access.ctx.scope);
    if (scopedAgentIds && !scopedAgentIds.includes(id)) {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const runs = await loadRunningRuns(companyId, [id], access.ctx.userId, access.ctx.scope);
    return NextResponse.json({ runs });
}
