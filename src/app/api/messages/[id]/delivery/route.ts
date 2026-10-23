import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { messageThreads } from "@/db/schema";
import { memberMaySeeAgent } from "@/lib/member-scope";
import { loadMessageDelivery } from "@/lib/run-ledger-reads";
import { companyRouteAccess } from "@/lib/company-access";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/messages/[id]/delivery — the delivery inspector's data: every stored
 * verdict for the message (agent, addressed, reason, streak/max), the runs it
 * triggered, and the message's current delivery state. Human session, scoped to
 * the caller's company.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid message id" }, { status: 400 });

    // A message in someone else's private direct thread reads as missing.
    const view = await loadMessageDelivery(companyId, id, access.ctx.userId);
    if (!view) return NextResponse.json({ error: "Message not found" }, { status: 404 });
    const scope = access.ctx.scope;
    if (scope) {
        // A restricted member inspects only messages to/with agents in their
        // scope, and sees only those agents' verdicts and runs.
        const [thread] = await db.select({ directAgentId: messageThreads.directAgentId }).from(messageThreads)
            .where(and(eq(messageThreads.companyId, companyId), eq(messageThreads.id, view.message.threadId))).limit(1);
        const involved = [view.message.targetAgentId, thread?.directAgentId].filter((agentId): agentId is string => Boolean(agentId));
        if (involved.some((agentId) => !memberMaySeeAgent(scope, agentId))) {
            return NextResponse.json({ error: "Message not found" }, { status: 404 });
        }
        return NextResponse.json({
            ...view,
            verdicts: view.verdicts.filter((v) => memberMaySeeAgent(scope, v.agentId)),
            runs: view.runs.filter((run) => memberMaySeeAgent(scope, run.agentId)),
        });
    }
    return NextResponse.json(view);
}
