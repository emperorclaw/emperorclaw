import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireRole } from "@/lib/roles";
import { editNowhereResponse, mayEditSomewhere } from "@/lib/resource-access";
import { archiveTasksForCaller, parseTaskIdList } from "@/lib/task-archive";

/**
 * POST /api/tasks/archive { taskIds } — archive many tasks at once (clearing a
 * Done column). Same checks as DELETE /api/tasks/[id]; tasks the caller may
 * not archive are skipped, not failed. Returns { archived: id[], skipped: id[] }.
 */
export async function POST(req: NextRequest) {
    let ctx;
    try {
        ctx = await requireRole("viewer")();
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        throw error;
    }
    // Resource-aware (0.20): a viewer with "Can edit" somewhere gets through; each task is checked below.
    if (!(await mayEditSomewhere(ctx))) return editNowhereResponse();

    const parsed = parseTaskIdList(await req.json().catch(() => null));
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    try {
        const result = await archiveTasksForCaller(ctx, parsed.ids);
        return NextResponse.json({ archived: result.tasks.map((task) => task.id), skipped: result.skipped });
    } catch (error) {
        console.error("Bulk task archive error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
