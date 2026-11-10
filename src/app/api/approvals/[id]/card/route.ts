import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, users } from "@/db/schema";
import { companyRouteAccess } from "@/lib/company-access";
import { alwaysAllowRefusal, approvalDecisionAccess } from "@/lib/approval-access";
import { wasAlwaysAllowed } from "@/lib/action-policy-rules";
import { approvalCardLabelFor } from "@/lib/approval-card";
import { approvalWaitingOnParts } from "@/lib/approval-routing-server";

/**
 * The live state of an approval card in chat (components/approval-card.tsx).
 *
 * Everyone who may see the approval gets its status and the neutral label the
 * card message already shows. The rationale, the decision note and the linked
 * tasks only go to people who may decide it — the same rule as
 * PATCH /api/approvals/[id] (lib/approval-access.ts) — because a thread can be
 * read by people who may not decide (a viewer, a "Can view" member), and an
 * action-permission rationale holds the action's arguments.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const { id } = await params;

    const { detail, denied, notApprover } = await approvalDecisionAccess(access.ctx, id);
    if (!detail) return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    const { approval } = detail;
    const mayDecide = !denied;
    // A member who may act on the ask but is not its approver still reads its
    // details (as before routing); only the decision is someone else's.
    const mayReadDetails = mayDecide || notApprover === true;

    const [requester] = approval.requesterAgentId
        ? await db.select({ name: agents.name }).from(agents).where(and(eq(agents.id, approval.requesterAgentId), eq(agents.companyId, companyId))).limit(1)
        : [];
    const [resolver] = mayReadDetails && approval.resolverUserId
        ? await db.select({ displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, approval.resolverUserId)).limit(1)
        : [];
    const [resolverAgent] = mayReadDetails && approval.resolverAgentId
        ? await db.select({ name: agents.name }).from(agents).where(and(eq(agents.id, approval.resolverAgentId), eq(agents.companyId, companyId))).limit(1)
        : [];

    return NextResponse.json({
        card: {
            approvalId: approval.id,
            status: approval.status,
            actionType: approval.actionType,
            label: await approvalCardLabelFor(companyId, approval),
            requesterName: requester?.name ?? null,
            requestedAt: approval.requestedAt,
            resolvedAt: approval.resolvedAt,
            mayDecide,
            // Approval routing: who the pending ask waits on ("Architect (agent)", "Jose, Luis"),
            // named only to people who may decide it; others see "Waiting on an approver".
            waitingOn: approval.status !== "pending" || !approval.approverKind ? null
                : mayDecide ? await approvalWaitingOnParts(companyId, approval) : { kind: "hidden", names: [] },
            // "Always allow" (0.30.1): offered on a pending action ask to people who may change the agent's permissions.
            mayAlwaysAllow: mayDecide && approval.status === "pending" && (await alwaysAllowRefusal(access.ctx, approval)) === null,
            ...(mayReadDetails ? {
                alwaysAllowed: approval.status === "approved" && wasAlwaysAllowed(approval.metadataJson),
                resolverName: resolver ? resolver.displayName || resolver.email : resolverAgent ? resolverAgent.name : null,
                resolverIsAgent: Boolean(resolverAgent),
                rationale: approval.rationale,
                resolutionNote: approval.resolutionNote,
                tasks: detail.tasks.map((task) => {
                    const input = task.inputJson && typeof task.inputJson === "object" ? task.inputJson as Record<string, unknown> : {};
                    return { id: task.id, title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : task.taskType };
                }),
            } : {}),
        },
    });
}
