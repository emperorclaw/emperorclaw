import { db } from "@/db";
import { approvals, approvalTaskLinks, tasks, projects, customers, agents, users, companyMembers } from "@/db/schema";
import { and, eq, isNull, desc, inArray, ne } from "drizzle-orm";
import { getCompanyId } from "@/lib/auth";
import { listPendingDecisions } from "@/lib/approvals";
import { redirect } from "next/navigation";
import ApprovalsClient, { type ApprovalItem } from "./approvals-client";

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
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

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
            resolverName: approval?.resolverUserId ? userById.get(approval.resolverUserId) ?? null : null,
            requester: requester ? { id: requester.id, name: requester.name, avatarUrl: requester.avatarUrl } : null,
            task: {
                id: task.id,
                projectId: task.projectId,
                title: taskTitle(task),
                description: taskDescription(task),
                state: task.state,
                assignee: task.assignedAgentId ? agentById.get(task.assignedAgentId)?.name ?? null : task.assignedMemberId ? memberById.get(task.assignedMemberId) ?? null : null,
            },
            linkedTasks: linked.map((t) => ({ id: t.id, projectId: t.projectId, title: taskTitle(t) })),
            projectName: project?.goal ?? null,
            customerName: customer?.name ?? null,
        };
    };

    const resolved: ApprovalItem[] = allApprovals.flatMap((approval) =>
        allLinks.filter((l) => l.approvalId === approval.id)
            .map((l) => tasksById.get(l.taskId))
            .filter((t): t is typeof tasks.$inferSelect => Boolean(t))
            .map((task) => toItem(task, approval)));

    // "Waiting on you" is the shared definition (sidebar badge and dashboard
    // read the same list): one card per pending approval, shown through its
    // first live task (deciding it resolves them all), then tasks flagged
    // "requires approval" with no request yet.
    const pending: ApprovalItem[] = [
        ...decisions.approvals.map(({ approval, tasks: linked }) => toItem(linked[0], approval, linked)),
        ...decisions.implicit.map((task) => toItem(task, null)),
    ];

    return <ApprovalsClient items={[...pending, ...resolved]} />;
}
