import { notFound, redirect } from "next/navigation";
import { AuthError, requireRole } from "@/lib/roles";
import { listActivity, listActivityActors } from "@/lib/audit-reads";
import { ActivityClient } from "./activity-client";

export const dynamic = "force-dynamic";

/**
 * Activity: who changed what (roadmap 11.3). Owners and admins only: anyone
 * else gets a 404, so the page never confirms it exists. The first page and
 * the actor filter options render on the server; the client pages and filters
 * through GET /api/activity and refetches when new entries are recorded.
 */
export default async function ActivityPage() {
    let guard;
    try {
        guard = await requireRole("admin")();
    } catch (error) {
        if (error instanceof AuthError && error.statusCode === 401) redirect("/login");
        notFound();
    }
    const [initial, actors] = await Promise.all([
        listActivity(guard.companyId, {}, null),
        listActivityActors(guard.companyId),
    ]);
    return <ActivityClient initial={initial} people={actors.people} agents={actors.agents} />;
}
