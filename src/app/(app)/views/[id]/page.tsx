import { notFound, redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { requireCompanyAccess } from "@/lib/company-access";
import { canWrite } from "@/lib/role-matrix";
import { memberAgentCondition } from "@/lib/member-scope";
import { getView, owningAgentId, ViewNotFoundError } from "@/lib/views";
import { RealtimeRefresh } from "@/lib/use-realtime";
import { ViewDetailClient } from "./view-client";

export const dynamic = "force-dynamic";

/**
 * One view: its panels on a 12-column grid (stacked on a phone), each with
 * "Updated … by …". Members can rename, pin, archive, revert and ask the
 * owning agent to refresh; viewers read. Out of scope reads as not found.
 */
export default async function ViewPage({ params }: { params: Promise<{ id: string }> }) {
    const access = await requireCompanyAccess("viewer").catch(() => null);
    if (!access) redirect("/login");
    const { id } = await params;
    const caller = { kind: "member" as const, userId: access.userId, scope: access.scope };
    let view;
    try {
        view = await getView(access.companyId, caller, id, { includeArchived: true });
    } catch (error) {
        if (error instanceof ViewNotFoundError) notFound();
        throw error;
    }
    const canEdit = canWrite(access.role);
    // Agents this person may message: the Refresh picker.
    const agentRows = canEdit ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(
        eq(agents.companyId, access.companyId), isNull(agents.deletedAt), memberAgentCondition(access.scope, agents.id),
    )).orderBy(asc(agents.name)).limit(300) : [];
    const owner = owningAgentId(view);

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 animate-in fade-in duration-500">
            <ViewDetailClient
                view={view}
                canEdit={canEdit}
                agents={agentRows}
                ownerAgentId={owner && agentRows.some((a) => a.id === owner) ? owner : null}
            />
            <RealtimeRefresh topics={[`view:${view.id}`]} />
        </div>
    );
}
