import { redirect } from "next/navigation";
import { requireRole } from "@/lib/roles";
import { attentionAccessFromGuard } from "@/lib/attention";
import { loadPaletteData } from "@/lib/palette";
import { taskViewerFromGuard } from "@/lib/task-story-reads";
import { defaultTimelineWindow, loadWorkTimeline } from "@/lib/work-timeline-reads";
import { TimelineClient } from "./timeline-client";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The company Timeline: a Gantt of who worked on what, when, and who handed
 * work to whom. The server renders the default 7-day window and the filter
 * options (member-scoped); the client re-fetches as the range and filters
 * change and keeps the chart live while today is in range.
 */
export default async function TimelinePage({ searchParams }: { searchParams: Promise<{ agentId?: string; projectId?: string; customerId?: string }> }) {
    const guard = await requireRole("viewer")().catch(() => null);
    if (!guard) redirect("/login");
    const companyId = guard.companyId;
    const viewer = await taskViewerFromGuard(guard);
    const params = await searchParams;
    // A malformed id in the URL is dropped rather than sent on (the API rejects it).
    const idParam = (value: string | undefined) => (value && UUID_RE.test(value) ? value : "");
    const agentId = idParam(params.agentId);
    const projectId = idParam(params.projectId);
    const customerId = idParam(params.customerId);
    const window = defaultTimelineWindow();
    const [filters, initial] = await Promise.all([
        loadPaletteData(companyId, attentionAccessFromGuard(guard).scope, ""),
        loadWorkTimeline(companyId, viewer, { ...window, agentId: agentId || null, projectId: projectId || null, customerId: customerId || null }),
    ]);
    return (
        <TimelineClient
            initial={initial}
            initialFilter={{ agentId, projectId, customerId }}
            agents={filters.agents.map((a) => ({ value: a.id, label: a.name }))}
            projects={filters.projects.map((p) => ({ value: p.id, label: p.name, description: p.customerName }))}
            customers={filters.customers.map((c) => ({ value: c.id, label: c.name }))}
        />
    );
}
