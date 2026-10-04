import { db } from "@/db";
import { customers, projects, tasks, incidents, approvals, pipelines } from "@/db/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { getScopeFromSession, getScopedCustomerIds } from "@/lib/member-scope";
import { redirect } from "next/navigation";
import CustomersClient from "./customers-client";

export const dynamic = "force-dynamic";

export default async function CustomersPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const session = await getValidatedServerSession();
    const scope = session ? getScopeFromSession(session) : null;
    const scopedCustomerIds = getScopedCustomerIds(scope);

    const customerConditions: any[] = [eq(customers.companyId, companyId), isNull(customers.deletedAt)];
    if (scopedCustomerIds) customerConditions.push(inArray(customers.id, scopedCustomerIds));

    const allCustomers = await db.select().from(customers).where(and(...customerConditions));
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
        // Only open work can be blocked; a finished task with stale dependencies is not.
        const blockedTasks = customerTasks.filter((task) => {
            if (["done", "failed", "dead_letter"].includes(task.state)) return false;
            const blockedBy = Array.isArray(task.blockedByTaskIds) ? task.blockedByTaskIds : [];
            return blockedBy.some((blockedId: string) => allTasks.some((otherTask) => otherTask.id === blockedId && otherTask.state !== "done"));
        });
        const reviewTasks = customerTasks.filter((task) => task.state === "review");
        const customerPipelines = allPipelines.filter((pipeline) => pipeline.customerId === customer.id || (pipeline.projectId && projectIds.has(pipeline.projectId)));

        const titleOf = (task: { inputJson: unknown; taskType: string }) => {
            const input = task.inputJson && typeof task.inputJson === "object" ? task.inputJson as Record<string, unknown> : {};
            return typeof input.title === "string" && input.title.trim() ? input.title.trim() : task.taskType;
        };
        const taskLink = (task: { id: string; projectId: string }) => `/projects?project=${task.projectId}&task=${task.id}`;
        // What "needs attention" means, item by item, each with where to fix it.
        const attention = [
            ...pendingApprovals.map((approval) => ({ kind: "approval", label: approval.rationale || "Approval requested", href: "/approvals" })),
            ...blockedTasks.map((task) => ({ kind: "blocked", label: titleOf(task), href: taskLink(task) })),
            ...customerIncidents.map((incident) => ({ kind: "incident", label: incident.summary, href: "/projects?attention=1" })),
            ...reviewTasks.map((task) => ({ kind: "review", label: titleOf(task), href: taskLink(task) })),
        ].slice(0, 12);
        const projectList = customerProjects.map((project) => ({
            id: project.id,
            goal: project.goal,
            status: project.status,
            openTasks: customerTasks.filter((task) => task.projectId === project.id && ["inbox", "in_progress", "review"].includes(task.state)).length,
        }));

        return {
            ...customer,
            attention,
            projects: projectList,
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
