import { NextResponse } from "next/server";
import { roleGte, type GuardContext } from "@/lib/roles";
import { alreadyDecidedText, deciderName, getApprovalDetail } from "@/lib/approvals";
import { memberMaySeeApproval, memberVisibleProjectIds } from "@/lib/member-scope";
import { recordResource, roleFor } from "@/lib/resource-access";
import { canAdmin } from "@/lib/role-matrix";
import { agentUseFor } from "@/lib/agent-access-server";
import { isAlwaysAllowableAsk } from "@/lib/action-policy-rules";
import { agentDeciders, approvalView, implicitTaskBlockReason, type ApprovalThreadPrivacy, type ApprovalBlockReason, type ApprovalView, type ApprovalViewer, type DecisionBasis, type RoutedApproval } from "@/lib/approval-routing";
import { approvalThreadPrivacy, approvalViewerFor } from "@/lib/approval-routing-server";

export type ApprovalDetail = NonNullable<Awaited<ReturnType<typeof getApprovalDetail>>>;
export type { ApprovalBlockReason, ApprovalView };

/** What the per-person rule needs of an approval row. */
export type ApprovalRowFacts = RoutedApproval & { id: string; status: string; projectId: string | null; requesterAgentId: string | null; threadId: string | null };

/**
 * Projects where this restricted member holds only "Can view" (role below
 * member), and those they cannot see at all (role null). One lookup per
 * distinct project; unrestricted people and owners/admins skip it.
 */
export async function viewOnlyProjects(ctx: GuardContext, projectIds: readonly (string | null | undefined)[]): Promise<{ viewOnly: Set<string>; unseen: Set<string> }> {
    const viewOnly = new Set<string>();
    const unseen = new Set<string>();
    if (!ctx.scope) return { viewOnly, unseen };
    const ids = [...new Set(projectIds.filter((id): id is string => Boolean(id)))];
    await Promise.all(ids.map(async (projectId) => {
        const resource = await recordResource(ctx.companyId, { projectId });
        const role = resource ? await roleFor(ctx, resource) : null;
        if (!role) unseen.add(projectId);
        else if (!roleGte(role, "member")) viewOnly.add(projectId);
    }));
    return { viewOnly, unseen };
}

/**
 * The single per-person rule for a batch of approvals (lib/approval-routing.ts
 * approvalView): member scope, the private-chat rule, view-only projects, the
 * decide basis, and whether they may read the details. Every surface (API,
 * pages, Inbox, badge, dashboard) reads this; the UI only reflects it.
 */
export async function approvalViewsFor(ctx: GuardContext, rows: readonly ApprovalRowFacts[], viewer?: ApprovalViewer): Promise<Map<string, ApprovalView>> {
    const out = new Map<string, ApprovalView>();
    if (!rows.length) return out;
    const [person, visibleProjects, threads, projects] = await Promise.all([
        viewer ?? approvalViewerFor(ctx.companyId, ctx.userId, ctx.role),
        memberVisibleProjectIds(ctx.companyId, ctx.scope),
        approvalThreadPrivacy(ctx.companyId, rows.map((row) => row.threadId)),
        viewOnlyProjects(ctx, rows.map((row) => row.projectId)),
    ]);
    for (const row of rows) {
        const inScope = memberMaySeeApproval(ctx.scope, visibleProjects, row) && !(row.projectId && projects.unseen.has(row.projectId));
        out.set(row.id, approvalView(row, person, {
            thread: row.threadId ? threads.get(row.threadId) ?? null : null,
            inScope,
            viewOnly: Boolean(row.projectId && projects.viewOnly.has(row.projectId)),
        }));
    }
    return out;
}

/** One approval's view for this person. */
export async function approvalViewFor(ctx: GuardContext, row: ApprovalRowFacts): Promise<ApprovalView> {
    return (await approvalViewsFor(ctx, [row])).get(row.id)!;
}

/**
 * Tasks flagged "requires approval" with no request yet: why this person may
 * not decide each (null: they may). Out-of-scope tasks are left out of the map.
 */
export async function implicitTaskReasons(ctx: GuardContext, taskRows: readonly { id: string; projectId: string; assignedAgentId: string | null }[], viewer?: ApprovalViewer): Promise<Map<string, ApprovalBlockReason | null>> {
    const out = new Map<string, ApprovalBlockReason | null>();
    if (!taskRows.length) return out;
    const [person, visibleProjects, projects] = await Promise.all([
        viewer ?? approvalViewerFor(ctx.companyId, ctx.userId, ctx.role),
        memberVisibleProjectIds(ctx.companyId, ctx.scope),
        viewOnlyProjects(ctx, taskRows.map((task) => task.projectId)),
    ]);
    for (const task of taskRows) {
        if ((visibleProjects && !visibleProjects.has(task.projectId)) || projects.unseen.has(task.projectId)) continue;
        out.set(task.id, implicitTaskBlockReason(task, person, projects.viewOnly.has(task.projectId)));
    }
    return out;
}

/** The fields everyone who may see an approval gets; the rest are details. */
const LABEL_FIELDS = ["id", "companyId", "projectId", "requesterAgentId", "actionType", "status", "requestedAt", "resolvedAt", "createdAt", "threadId", "cardMessageId", "projectGoal", "taskIds"] as const;

/**
 * An approval row cut to its label for someone who may not read its details:
 * no rationale, arguments, routing, note or who decided. An ask-first action
 * keeps its action's display name (the card shows it too).
 */
export function redactApproval<T extends object>(row: T): Partial<T> & { redacted: true; label?: string } {
    const source = row as Record<string, unknown>;
    const out: Record<string, unknown> = { redacted: true };
    for (const key of LABEL_FIELDS) if (key in source) out[key] = source[key];
    const meta = source.metadataJson && typeof source.metadataJson === "object" ? source.metadataJson as Record<string, unknown> : null;
    if (meta && typeof meta.actionLabel === "string") out.label = meta.actionLabel;
    return out as Partial<T> & { redacted: true; label?: string };
}

/** The row as this person may read it. */
export function approvalForReader<T extends object>(row: T, view: ApprovalView): T | (Partial<T> & { redacted: true }) {
    return view.mayReadDetails ? row : redactApproval(row);
}

export type ApprovalDecisionAccess = {
    detail: ApprovalDetail | null;
    denied: NextResponse | null;
    /** Denied only because a routed ask waits on someone else (they still read its details). */
    notApprover?: boolean;
    reason?: ApprovalBlockReason | null;
    /** Why the person may decide it (kept in the decision's audit). */
    basis?: DecisionBasis | null;
    view?: ApprovalView;
};

const NOT_FOUND = () => NextResponse.json({ error: "Approval not found" }, { status: 404 });

const DENIED: Record<ApprovalBlockReason, string> = {
    viewer: "Forbidden — this action requires one of: member.",
    view_only: "Forbidden — this action requires member access to this project.",
    waiting_on_other: "Waiting on another approver: only the approver, an owner or an admin can decide this request.",
    not_permitted: "You can't decide approvals here: ask an owner or admin, the agent's owner, or someone allowed to decide approvals.",
};

/**
 * Who may see and who may decide a human-decided approval: the one rule
 * PATCH /api/approvals/[id] (Inbox, Approvals page, chat cards), the MCP
 * PATCH, GET /api/approvals/[id] and the chat card share (approvalView).
 *
 * - detail null: the approval does not exist or the person may not see it (404).
 * - denied set: they see it but may not decide it; reason says why. On a
 *   decided ask it is set only for people who never could have decided it
 *   (viewer, view_only, not_permitted): they get 403, never the 409 with the
 *   stored row. A routed ask's other members keep the 409.
 */
export async function approvalDecisionAccess(ctx: GuardContext, approvalId: string): Promise<ApprovalDecisionAccess> {
    const detail = await getApprovalDetail(ctx.companyId, approvalId);
    if (!detail) return { detail: null, denied: NOT_FOUND() };
    const view = await approvalViewFor(ctx, detail.approval);
    if (!view.visible) return { detail: null, denied: NOT_FOUND() };
    const { reason, basis } = view;
    const decided = detail.approval.status !== "pending";
    if (!reason || (decided && reason === "waiting_on_other")) return { detail, denied: null, basis, reason, view };
    return {
        detail, reason, basis, view,
        notApprover: reason === "waiting_on_other",
        denied: NextResponse.json({ error: DENIED[reason], reason }, { status: 403 }),
    };
}

/**
 * May this person answer an ask with "Always allow" (approve it and set the
 * requesting agent's permission for the action to "allowed")? Changing a
 * permission follows PUT /api/agents/[id]/action-policies: owners and admins
 * only, and loosening needs full use of the agent. null = yes.
 */
export async function alwaysAllowRefusal(ctx: GuardContext, approval: ApprovalDetail["approval"]): Promise<{ error: string; status: number } | null> {
    if (!canAdmin(ctx.role)) return { error: "Only owners and admins can always allow an action.", status: 403 };
    if (!isAlwaysAllowableAsk(approval)) return { error: "Always allow applies only to an agent's request for an action permission.", status: 400 };
    if ((await agentUseFor(ctx, approval.requesterAgentId)) !== "full") {
        return { error: "This agent is limited to other people: you can't loosen its permissions.", status: 403 };
    }
    return null;
}

/** 409 for the loser of a decision race (or a repeat): who decided, and the stored approval. */
export async function alreadyDecidedResponse(companyId: string, approval: ApprovalDetail["approval"]): Promise<NextResponse> {
    return NextResponse.json({
        error: await alreadyDecidedText(companyId, approval),
        alreadyDecided: true,
        decidedBy: await deciderName(companyId, approval),
        approval,
    }, { status: 409 });
}

/**
 * An agent token's view of an approval (GET /api/mcp/approvals, /[id]): a
 * card in a person's private chat is visible only to that chat's agent, the
 * requester and an agent that may decide it; details only for the requester
 * and its agent deciders. An operator token (acting as no agent) never sees
 * private-chat asks and reads the rest in full, as before.
 */
export function mcpApprovalView(
    access: { agentId: string | null },
    approval: RoutedApproval & { requesterAgentId: string | null },
    thread: (ApprovalThreadPrivacy & { directAgentId?: string | null }) | null,
): { visible: boolean; mayReadDetails: boolean } {
    const agentId = access.agentId;
    const involved = Boolean(agentId) && (approval.requesterAgentId === agentId || agentDeciders(approval).includes(agentId!));
    const isPrivate = Boolean(thread) && thread!.type === "direct" && (Boolean(thread!.isPrivate) || Boolean(thread!.ownerUserId));
    if (isPrivate && !involved && !(agentId && thread!.directAgentId === agentId)) return { visible: false, mayReadDetails: false };
    return { visible: true, mayReadDetails: agentId ? involved : true };
}

/**
 * approvalViewsFor for a viewer that is not a role guard (lib/task-story-reads.ts
 * TaskViewer: user id, role and scope from the DB). Nobody signed in: only
 * what is not in a private chat, and never the details.
 */
export async function approvalViewsForPerson(
    companyId: string,
    person: { userId: string | null; role: string; scope: GuardContext["scope"] },
    rows: readonly ApprovalRowFacts[],
): Promise<Map<string, ApprovalView>> {
    if (person.userId) return approvalViewsFor({ companyId, userId: person.userId, role: person.role as GuardContext["role"], scope: person.scope }, rows);
    const threads = await approvalThreadPrivacy(companyId, rows.map((row) => row.threadId));
    const nobody: ApprovalViewer = { userId: "", isOwnerOrAdmin: false, mayAct: false };
    return new Map(rows.map((row) => [row.id, approvalView(row, nobody, { thread: row.threadId ? threads.get(row.threadId) ?? null : null, inScope: true })]));
}
