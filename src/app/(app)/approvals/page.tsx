import { db } from "@/db";
import { approvals, approvalTaskLinks, tasks, projects, customers, agents, users, companyMembers } from "@/db/schema";
import { and, eq, isNull, desc, inArray, ne, or } from "drizzle-orm";
import { getCompanyId } from "@/lib/auth";
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

    const [allApprovals, allLinks, allProjects, allCustomers, allAgents, people] = await Promise.all([
        db.select().from(approvals).where(eq(approvals.companyId, companyId)).orderBy(desc(approvals.requestedAt)).limit(300),
        db.select().from(approvalTaskLinks).where(eq(approvalTaskLinks.companyId, companyId)),
        db.select().from(projects).where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt))),
        db.select().from(customers).where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt))),
        db.select({ id: agents.id, name: agents.name, avatarUrl: agents.avatarUrl }).from(agents).where(eq(agents.companyId, companyId)),
        db.select({ id: users.id, memberId: companyMembers.id, displayName: users.displayName, email: users.email }).from(companyMembers)
            .innerJoin(users, eq(users.id, companyMembers.userId)).where(eq(companyMembers.companyId, companyId)),
    ]);
    const linkedTaskIds = [...new Set(allLinks.map((l) => l.taskId))];
    const allTasks = await db.select().from(tasks).where(and(
        eq(tasks.companyId, companyId),
        isNull(tasks.deletedAt),
        or(
            linkedTaskIds.length ? inArray(tasks.id, linkedTaskIds) : undefined,
            and(eq(tasks.humanApprovalRequired, true), ne(tasks.state, "done")),
        ),
    ));

    const tasksById = new Map(allTasks.map((t) => [t.id, t]));
    const projectById = new Map(allProjects.map((p) => [p.id, p]));
    const customerById = new Map(allCustomers.map((c) => [c.id, c]));
    const agentById = new Map(allAgents.map((a) => [a.id, a]));
    const userById = new Map(people.map((p) => [p.id, p.displayName || p.email]));
    const memberById = new Map(people.map((p) => [p.memberId, p.displayName || p.email]));

    const toItem = (task: typeof tasks.$inferSelect, approval: typeof approvals.$inferSelect | null): ApprovalItem => {
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
            projectName: project?.goal ?? null,
            customerName: customer?.name ?? null,
        };
    };

    const items: ApprovalItem[] = allApprovals.flatMap((approval) =>
        allLinks.filter((l) => l.approvalId === approval.id)
            .map((l) => tasksById.get(l.taskId))
            .filter((t): t is typeof tasks.$inferSelect => Boolean(t))
            .map((task) => toItem(task, approval)));

    // Tasks flagged "requires approval" with no request yet, still open.
    const covered = new Set(items.map((i) => i.task.id));
    const implicit = allTasks.filter((t) => t.humanApprovalRequired && t.state !== "done" && !covered.has(t.id)).map((t) => toItem(t, null));

    return <ApprovalsClient items={[...items, ...implicit]} />;
}
