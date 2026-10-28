import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { getScopedAgentIds } from "@/lib/member-scope";
import { loadRunTimeline } from "@/lib/run-ledger-reads";
import { usableAgentIdList } from "@/lib/agent-access-server";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/runs/[runId]/events — one run's timeline (tool steps with
 * durations, reasoning lines, notices, usage) for the reply-bubble footer and
 * the Runs tab. Human session, scoped to the caller's company and member
 * scope. A run in a private thread the viewer is not part of is redacted
 * (no summaries, generic error), like the Right now card.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    const { runId } = await params;
    if (!UUID_RE.test(runId)) return NextResponse.json({ error: "Invalid run id" }, { status: 400 });

    // A run of an agent limited to other people (0.20) reads as missing: its steps and reasoning are theirs.
    const agentIds = await usableAgentIdList(access.ctx, getScopedAgentIds(access.ctx.scope));
    const view = await loadRunTimeline(companyId, runId, { viewerUserId: access.ctx.userId, agentIds });
    if (!view) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
