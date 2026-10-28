import { notFound, redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { requireCompanyAccess } from "@/lib/company-access";
import { canAdmin, canWrite } from "@/lib/role-matrix";
import { memberAgentCondition } from "@/lib/member-scope";
import { getView, listViewTransferPeople, memberViewCaller, owningAgentId, ViewNotFoundError } from "@/lib/views";
import { RealtimeRefresh } from "@/lib/use-realtime";
import { getDirectChatMode } from "@/lib/control-plane";
import { ViewDetailClient, ViewMetadataClient } from "./view-client";

export const dynamic = "force-dynamic";

/**
 * One view: its panels on a 12-column grid (stacked on a phone), each with
 * "Updated … by …" and "Ask about this panel". Members can rename, archive,
 * revert and ask the maintaining agent to refresh; everyone who can open it
 * can pin it to their own Home; its owner decides who sees it. An owner/admin
 * outside a private view sees its metadata only (and may delete or transfer
 * it). Not visible reads as not found.
 */
export default async function ViewPage({ params }: { params: Promise<{ id: string }> }) {
    const access = await requireCompanyAccess("viewer").catch(() => null);
    if (!access) redirect("/login");
    const { id } = await params;
    let view;
    try {
        view = await getView(access.companyId, memberViewCaller(access), id, { includeArchived: true, allowMetadata: true });
    } catch (error) {
        if (error instanceof ViewNotFoundError) notFound();
        throw error;
    }
    const isAdmin = canAdmin(access.role);
    const isOwner = view.owner?.id === access.userId;
    // Offboarding: owners/admins (and the view's owner) may hand it to another
    // member who can see its scope; never to themselves when they cannot open it.
    const transferTo = isAdmin || isOwner ? await listViewTransferPeople(access.companyId, memberViewCaller(access), id) : [];

    if (view.access === "metadata") {
        return (
            <div className="mx-auto max-w-[1000px] space-y-5 animate-in fade-in duration-500">
                <ViewMetadataClient view={view} transferTo={transferTo} />
            </div>
        );
    }

    const canEdit = canWrite(access.role);
    // Agents this person may message: the Refresh picker and "Ask about this panel".
    const agentRows = canEdit ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(
        eq(agents.companyId, access.companyId), isNull(agents.deletedAt), memberAgentCondition(access.scope, agents.id),
    )).orderBy(asc(agents.name)).limit(300) : [];
    const maintainer = owningAgentId(view);
    // "Ask about this panel" opens the person's direct chat with the maintainer.
    // In shared direct-chat mode that chat is the whole company's, so a private
    // or shared view is never quoted there.
    const chatIsPrivate = view.visibility === "scope" || (await getDirectChatMode(access.companyId)) === "private";
    const askAgentId = maintainer && chatIsPrivate && agentRows.some((a) => a.id === maintainer) ? maintainer : null;

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 animate-in fade-in duration-500">
            <ViewDetailClient
                view={view}
                canEdit={canEdit}
                canManage={isAdmin || isOwner}
                isOwner={isOwner}
                agents={agentRows}
                ownerAgentId={maintainer && agentRows.some((a) => a.id === maintainer) ? maintainer : null}
                askAgentId={askAgentId}
                transferTo={transferTo}
            />
            <RealtimeRefresh topics={[`view:${view.id}`]} />
        </div>
    );
}
