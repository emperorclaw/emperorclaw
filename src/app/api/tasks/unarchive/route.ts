import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireRole } from "@/lib/roles";
import { editNowhereResponse, mayEditSomewhere } from "@/lib/resource-access";
import { parseTaskIdList, unarchiveTasksForCaller } from "@/lib/task-archive";

/**
 * POST /api/tasks/unarchive { taskIds } — undo a recent archive. Restores only
 * tasks archived in the last 10 minutes that the caller may edit; the rest are
 * skipped. Returns { restored: id[], skipped: id[] }.
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
        const result = await unarchiveTasksForCaller(ctx, parsed.ids);
        return NextResponse.json({ restored: result.tasks.map((task) => task.id), skipped: result.skipped });
    } catch (error) {
        console.error("Bulk task unarchive error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
