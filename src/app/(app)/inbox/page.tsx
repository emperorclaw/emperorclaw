import { redirect } from "next/navigation";
import { requireRole } from "@/lib/roles";
import { attentionAccessFromGuard, buildAttention, parseInboxFilter } from "@/lib/attention";
import { RealtimeRefresh } from "@/lib/use-realtime";
import { InboxClient } from "./inbox-client";

export const dynamic = "force-dynamic";

/**
 * "Needs me": every decision, blocker and signal waiting on the signed-in
 * person. Built by the same function as the Inbox badge and the dashboard's
 * Action inbox (src/lib/attention.ts), so the counts always agree.
 */
export default async function InboxPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
    // Role and member scope from the DB (requireRole), not the session copies.
    const guard = await requireRole("viewer")().catch(() => null);
    if (!guard) redirect("/login");
    const companyId = guard.companyId;
    const params = await searchParams;
    const access = attentionAccessFromGuard(guard);
    const result = await buildAttention(companyId, access);

    return (
        <>
            <RealtimeRefresh topics={["inbox"]} />
            <InboxClient
                entries={result.entries}
                agents={result.agents}
                generatedAt={result.generatedAt}
                canAct={access.canAct}
                filter={parseInboxFilter(params.filter)}
            />
        </>
    );
}
