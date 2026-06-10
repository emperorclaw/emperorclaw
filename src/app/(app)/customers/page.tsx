import { db } from "@/db";
import { customers, projects, tasks, incidents, approvals, pipelines } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { getCompanyId } from "@/lib/auth";
import { redirect } from "next/navigation";
import CustomersClient from "./customers-client";

export const dynamic = "force-dynamic";

export default async function CustomersPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const allCustomers = await db.select().from(customers).where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt)));
    const allProjects = await db.select().from(projects).where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt)));
    const allTasks = await db.select().from(tasks).where(and(eq(tasks.companyId, companyId), isNull(tasks.deletedAt)));
    const allIncidents = await db.select().from(incidents).where(and(eq(incidents.companyId, companyId), isNull(incidents.deletedAt)));
    const allApprovals = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    const allPipelines = await db.select().from(pipelines).where(and(eq(pipelines.companyId, companyId), isNull(pipelines.deletedAt)));

    const customerSummaries = allCustomers.map((customer) => {
        const customerProjects = allProjects.filter((project) => project.customerId === customer.id);
        const projectIds = new Set(customerProjects.map((project) => project.id));
        const customerTasks = allTasks.filter((task) => projectIds.has(task.projectId));
        const customerIncidents = allIncidents.filter((incident) => projectIds.has(incident.projectId) && incident.status !== "resolved");
        const pendingApprovals = allApprovals.filter((approval) => approval.projectId && projectIds.has(approval.projectId) && approval.status === "pending");
        const blockedTasks = customerTasks.filter((task) => {
            const blockedBy = Array.isArray(task.blockedByTaskIds) ? task.blockedByTaskIds : [];
            return blockedBy.some((blockedId: string) => allTasks.some((otherTask) => otherTask.id === blockedId && otherTask.state !== "done"));
        });
        const reviewTasks = customerTasks.filter((task) => task.state === "review");
        const customerPipelines = allPipelines.filter((pipeline) => pipeline.customerId === customer.id || (pipeline.projectId && projectIds.has(pipeline.projectId)));

        return {
            ...customer,
            projectCount: customerProjects.length,
            taskCount: customerTasks.length,
            reviewCount: reviewTasks.length,
            blockedCount: blockedTasks.length,
            incidentCount: customerIncidents.length,
            pendingApprovalCount: pendingApprovals.length,
            pipelineCount: customerPipelines.length,
        };
    });

    return <CustomersClient initialData={customerSummaries} />;
}
