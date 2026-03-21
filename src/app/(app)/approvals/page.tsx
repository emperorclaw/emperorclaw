/* eslint-disable @typescript-eslint/no-explicit-any */
import { db } from "@/db";
import { approvals, approvalTaskLinks, tasks, projects, customers, agents } from "@/db/schema";
import { and, eq, isNull, desc } from "drizzle-orm";
import { getCompanyId } from "@/lib/auth";
import { redirect } from "next/navigation";
import ApprovalsClient from "./approvals-client";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const [allApprovals, allLinks, allTasks, allProjects, allCustomers, allAgents] = await Promise.all([
        db.select().from(approvals).where(eq(approvals.companyId, companyId)).orderBy(desc(approvals.requestedAt)),
        db.select().from(approvalTaskLinks).where(eq(approvalTaskLinks.companyId, companyId)),
        db.select().from(tasks).where(and(eq(tasks.companyId, companyId), isNull(tasks.deletedAt))),
        db.select().from(projects).where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt))),
        db.select().from(customers).where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt))),
        db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
    ]);

    const tasksById = new Map(allTasks.map((task) => [task.id, task]));
    const projectById = new Map(allProjects.map((project) => [project.id, project]));
    const customerById = new Map(allCustomers.map((customer) => [customer.id, customer]));
    const agentById = new Map(allAgents.map((agent) => [agent.id, agent]));

    const items = allApprovals.flatMap((approval) => {
        const linkedTaskIds = allLinks.filter((link) => link.approvalId === approval.id).map((link) => link.taskId);
        const linkedTasks = linkedTaskIds.map((taskId) => tasksById.get(taskId)).filter(Boolean) as any[];

        if (linkedTasks.length === 0) {
            return [];
        }

        return linkedTasks.map((task) => {
            const project = projectById.get(task.projectId);
            const customer = project?.customerId ? customerById.get(project.customerId) : null;
            return {
                approval,
                task,
                project,
                customer,
                requester: approval.requesterAgentId ? agentById.get(approval.requesterAgentId) : null,
                resolver: approval.resolverUserId,
            };
        });
    });

    const implicitItems = allTasks
        .filter((task) => task.humanApprovalRequired && !items.some((item) => item.task?.id === task.id))
        .map((task) => {
            const project = projectById.get(task.projectId);
            const customer = project?.customerId ? customerById.get(project.customerId) : null;
            return {
                approval: null,
                task,
                project,
                customer,
                requester: task.assignedAgentId ? agentById.get(task.assignedAgentId) : null,
                resolver: null,
            };
        });

    return <ApprovalsClient items={[...items, ...implicitItems]} />;
}
