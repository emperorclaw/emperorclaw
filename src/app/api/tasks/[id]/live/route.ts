import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { loadTaskLive, taskViewerFromGuard } from "@/lib/task-story-reads";

export const dynamic = "force-dynamic";

/**
 * GET /api/tasks/[id]/live — the task page's pinned live block: running runs
 * on the task with their newest steps, usage and last useful action. Polled
 * fast while a run is live and slowly otherwise. Company and member scoped; a
 * run in someone else's private chat comes back without its activity.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const { id } = await params;
    const viewer = await taskViewerFromGuard(access.ctx);
    const live = await loadTaskLive(companyId, id, viewer);
    if (!live) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json(live, { headers: { "Cache-Control": "no-store" } });
}
