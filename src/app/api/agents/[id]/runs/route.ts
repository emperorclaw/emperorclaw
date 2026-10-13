import { NextRequest, NextResponse } from "next/server";
import { getCompanyId } from "@/lib/auth";
import { loadAgentRunsPage } from "@/lib/run-ledger-reads";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/agents/[id]/runs?cursor=&status= — an agent's recent runs, newest
 * first, 50 per page, plus the last 30 days of daily rollups. Human session,
 * scoped to the caller's company.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid agent id" }, { status: 400 });

    const { searchParams } = new URL(req.url);
    const page = await loadAgentRunsPage(companyId, id, {
        cursor: searchParams.get("cursor"),
        status: searchParams.get("status"),
    });
    return NextResponse.json(page);
}
