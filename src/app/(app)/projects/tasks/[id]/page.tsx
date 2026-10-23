import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/roles";
import { canWrite } from "@/lib/role-matrix";
import { loadTaskStory, taskViewerFromGuard } from "@/lib/task-story-reads";
import { TaskPageClient } from "./task-page-client";

export const dynamic = "force-dynamic";

/**
 * The task page (slice 10.4): header, the pinned live run, and one merged
 * timeline of events, approvals, files, messages and runs, grouped by day.
 * A task of another company, a deleted one, or one outside a restricted
 * member's scope is a 404.
 */
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
    // Role and member scope from the DB (requireRole), not the session copies.
    const guard = await requireRole("viewer")().catch(() => null);
    if (!guard) redirect("/login");
    const { id } = await params;
    const viewer = await taskViewerFromGuard(guard);
    const story = await loadTaskStory(guard.companyId, id, viewer);
    if (!story) notFound();
    return <TaskPageClient story={story} canEdit={canWrite(guard.role)} />;
}
