import { db } from "@/db";
import { approvals, approvalTaskLinks, tasks, projects, customers, agents, users, companyMembers } from "@/db/schema";
import { and, eq, isNull, desc, inArray, ne } from "drizzle-orm";
import { requireRole } from "@/lib/roles";
import { currentApproverStep, waitingOnParts, type ApprovalView } from "@/lib/approval-routing";
import { approvalViewerFor } from "@/lib/approval-routing-server";
import { approvalViewsFor, implicitTaskReasons } from "@/lib/approval-access";
import { listPendingDecisions } from "@/lib/approvals";
import { redirect } from "next/navigation";
import ApprovalsClient, { type ApprovalItem } from "./approvals-client";
import { splitProjectTitle } from "@/lib/project-title";
import { isActionApproval, storedActionArgs } from "@/lib/action-policy-rules";
import { actionLabel } from "@/lib/action-policy";

export const dynamic = "force-dynamic";

function taskTitle(task: typeof tasks.$inferSelect): string {
    const input = task.inputJson && typeof task.inputJson === "object" ? task.inputJson as Record<string, unknown> : {};
    return typeof input.title === "string" && input.title.trim() ? input.title.trim() : task.taskType;
}

function taskDescription(task: typeof tasks.$inferSelect): string | null {
    const input = task.inputJson && typeof task.inputJson === "object" ? task.inputJson as Record<string, unknown> : {};
    const value = input.description ?? input.prompt;
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export default async function ApprovalsPage() {
    // Role from the DB: a routed ask is listed as waiting only for its approvers (owners and admins see all).
    const guard = await requireRole("viewer")().catch(() => null);
    if (!guard) redirect("/login");
    const companyId = guard.companyId;
    const viewer = await approvalViewerFor(companyId, guard.userId, guard.role);

    const [decisions, allApprovals, allLinks, allProjects, allCustomers, allAgents, people] = await Promise.all([
        listPendingDecisions(companyId),
        db.select().from(approvals).where(and(eq(approvals.companyId, companyId), ne(approvals.status, "pending"))).orderBy(desc(approvals.resolvedAt)).limit(300),
        db.select().from(approvalTaskLinks).where(eq(approvalTaskLinks.companyId, companyId)),
        db.select().from(projects).where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt))),
        db.select().from(customers).where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt))),
        db.select({ id: agents.id, name: agents.name, avatarUrl: agents.avatarUrl }).from(agents).where(eq(agents.companyId, companyId)),
        db.select({ id: users.id, memberId: companyMembers.id, displayName: users.displayName, email: users.email }).from(companyMembers)
            .innerJoin(users, eq(users.id, companyMembers.userId)).where(eq(companyMembers.companyId, companyId)),
    ]);
    // The one per-person rule (lib/approval-access.ts): scope, private chats,
    // "Can view" projects, who may decide and who may read the details.
    const [views, implicitReasons] = await Promise.all([
        approvalViewsFor(guard, [...decisions.approvals.map(({ approval }) => approval), ...allApprovals], viewer),
        implicitTaskReasons(guard, decisions.implicit, viewer),
    ]);
    const viewOf = (approval: typeof approvals.$inferSelect): ApprovalView | null => {
        const view = views.get(approval.id);
        return view?.visible ? view : null;
    };
    const linkedTaskIds = [...new Set(allLinks.map((l) => l.taskId))];
    // Tasks of resolved approvals, for the "Recently decided" list.
    const allTasks = linkedTaskIds.length
        ? await db.select().from(tasks).where(and(eq(tasks.companyId, companyId), isNull(tasks.deletedAt), inArray(tasks.id, linkedTaskIds)))
        : [];

    const tasksById = new Map(allTasks.map((t) => [t.id, t]));
    const projectById = new Map(allProjects.map((p) => [p.id, p]));
    const customerById = new Map(allCustomers.map((c) => [c.id, c]));
    const agentById = new Map(allAgents.map((a) => [a.id, a]));
    const userById = new Map(people.map((p) => [p.id, p.displayName || p.email]));
    const names = { agent: (id: string) => agentById.get(id)?.name ?? "An agent", person: (id: string) => userById.get(id) ?? "A person" };
    const routing = (approval: typeof approvals.$inferSelect | null) => ({
        resolverName: approval?.resolverUserId ? userById.get(approval.resolverUserId) ?? null : approval?.resolverAgentId ? agentById.get(approval.resolverAgentId)?.name ?? null : null,
        resolverIsAgent: Boolean(approval?.resolverAgentId && !approval.resolverUserId),
        waitingOn: approval?.status === "pending" && approval.approverKind ? waitingOnParts(currentApproverStep(approval), names) : null,
    });
    const memberById = new Map(people.map((p) => [p.memberId, p.displayName || p.email]));

    const toItem = (task: typeof tasks.$inferSelect, approval: typeof approvals.$inferSelect | null, linked: (typeof tasks.$inferSelect)[] = [task]): ApprovalItem => {
        const project = projectById.get(task.projectId);
        const customer = project?.customerId ? customerById.get(project.customerId) : null;
        const requester = approval?.requesterAgentId ? agentById.get(approval.requesterAgentId) : task.assignedAgentId ? agentById.get(task.assignedAgentId) : null;
        return {
            key: `${approval?.id ?? "implicit"}:${task.id}`,
            approvalId: approval?.id ?? null,
            status: (approval?.status ?? "pending") as ApprovalItem["status"],
            actionType: approval?.actionType ?? "task_done",
            rationale: approval?.rationale ?? null,
            resolutionNote: approval?.resolutionNote ?? null,
            requestedAt: (approval?.requestedAt ?? task.updatedAt).toISOString(),
            resolvedAt: approval?.resolvedAt ? approval.resolvedAt.toISOString() : null,
            ...routing(approval),
            requester: requester ? { id: requester.id, name: requester.name, avatarUrl: requester.avatarUrl } : null,
            task: {
                id: task.id,
                projectId: task.projectId,
                title: taskTitle(task),
                description: taskDescription(task),
                state: task.state,
                assignee: task.assignedAgentId ? agentById.get(task.assignedAgentId)?.name ?? null : task.assignedMemberId ? memberById.get(task.assignedMemberId) ?? null : null,
            },
            action: null,
            linkedTasks: linked.map((t) => ({ id: t.id, projectId: t.projectId, title: taskTitle(t) })),
            projectName: project?.goal ? splitProjectTitle(project.goal).name : null,
            customerName: customer?.name ?? null,
        };
    };

    // An agent asking to run one action (an "ask first" permission): no task, the action and its arguments instead.
    const toActionItem = (approval: typeof approvals.$inferSelect): ApprovalItem => {
        const args = storedActionArgs(approval.metadataJson);
        const requester = approval.requesterAgentId ? agentById.get(approval.requesterAgentId) : null;
        return {
            key: approval.id,
            approvalId: approval.id,
            status: approval.status as ApprovalItem["status"],
            actionType: approval.actionType,
            rationale: null,
            resolutionNote: approval.resolutionNote,
            requestedAt: approval.requestedAt.toISOString(),
            resolvedAt: approval.resolvedAt ? approval.resolvedAt.toISOString() : null,
            ...routing(approval),
            requester: requester ? { id: requester.id, name: requester.name, avatarUrl: requester.avatarUrl } : null,
            task: null,
            action: { key: approval.actionType, label: actionLabel(approval.actionType), args },
            linkedTasks: [],
            projectName: null,
            customerName: null,
        };
    };

    /**
     * The label only, for someone who may not read the details: no task title
     * or description, arguments, rationale, routing, note or who decided
     * (also kept out of the client's search).
     */
    const redacted = (approval: typeof approvals.$inferSelect): ApprovalItem => {
        const requester = approval.requesterAgentId ? agentById.get(approval.requesterAgentId) : null;
        const project = approval.projectId ? projectById.get(approval.projectId) : null;
        return {
            key: approval.id,
            approvalId: approval.id,
            status: approval.status as ApprovalItem["status"],
            actionType: approval.actionType,
            rationale: null,
            resolutionNote: null,
            requestedAt: approval.requestedAt.toISOString(),
            resolvedAt: approval.resolvedAt ? approval.resolvedAt.toISOString() : null,
            resolverName: null,
            waitingOn: approval.status === "pending" && approval.approverKind ? { kind: "hidden", names: [] } : null,
            requester: requester ? { id: requester.id, name: requester.name, avatarUrl: requester.avatarUrl } : null,
            task: null,
            action: isActionApproval(approval) ? { key: approval.actionType, label: actionLabel(approval.actionType), args: [] } : null,
            linkedTasks: [],
            projectName: project?.goal ? splitProjectTitle(project.goal).name : null,
            customerName: null,
            redacted: true,
        };
    };

    const resolved: ApprovalItem[] = allApprovals.flatMap((approval) => {
        const view = viewOf(approval);
        if (!view) return [];
        if (!view.mayReadDetails) return [redacted(approval)];
        return isActionApproval(approval) ? [toActionItem(approval)] :
            allLinks.filter((l) => l.approvalId === approval.id)
                .map((l) => tasksById.get(l.taskId))
                .filter((t): t is typeof tasks.$inferSelect => Boolean(t))
                .map((task) => toItem(task, approval));
    });

    // "Waiting on you" is the shared definition (sidebar badge and dashboard
    // read the same list): one card per pending approval, shown through its
    // first live task (deciding it resolves them all), then tasks flagged
    // "requires approval" with no request yet. Pending asks this person sees
    // but may not decide are listed read-only, with the reason (the API
    // refuses their decision with 403 either way).
    const pending: ApprovalItem[] = [
        ...decisions.approvals.flatMap(({ approval, tasks: linked }) => {
            const view = viewOf(approval);
            if (!view) return [];
            if (view.mayDecide) return [linked[0] ? toItem(linked[0], approval, linked) : toActionItem(approval)];
            const base = view.mayReadDetails ? (linked[0] ? toItem(linked[0], approval, linked) : toActionItem(approval)) : redacted(approval);
            // Approvers are named only to people who may decide it.
            return [{ ...base, canDecide: false, blockedReason: view.reason ?? "not_permitted", waitingOn: base.waitingOn ? { kind: "hidden" as const, names: [] } : null }];
        }),
        // A task flagged "requires approval" with no request yet: deciding it
        // creates an unrouted ask, so the same people decide it.
        ...decisions.implicit.flatMap((task) => {
            if (!implicitReasons.has(task.id)) return [];
            const reason = implicitReasons.get(task.id) ?? null;
            const item = toItem(task, null);
            return [reason ? { ...item, canDecide: false, blockedReason: reason, task: item.task ? { ...item.task, description: null } : null } : item];
        }),
    ];

    return <ApprovalsClient items={[...pending, ...resolved]} />;
}
