import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { loadTaskStory, taskViewerFromGuard } from "@/lib/task-story-reads";

export const dynamic = "force-dynamic";

/**
 * GET /api/tasks/[id]/story?before=<ISO> — an older page of the task's merged
 * timeline ("Load older"). Same scoping and redaction as the page itself.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const { id } = await params;
    const before = req.nextUrl.searchParams.get("before");
    const viewer = await taskViewerFromGuard(access.ctx);
    const story = await loadTaskStory(companyId, id, viewer, { before });
    if (!story) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json(
        { entries: story.entries, hasMore: story.hasMore, nextBefore: story.nextBefore },
        { headers: { "Cache-Control": "no-store" } },
    );
}
