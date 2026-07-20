import { getValidatedServerSession } from "@/lib/auth";
import { getScopeFromSession, getScopedCustomerIds } from "@/lib/member-scope";
import { db } from "@/db";
import { projects, tasks, companyMembers, customers } from "@/db/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import ArtifactsManager from "./artifacts-manager";

export const dynamic = "force-dynamic";

export default async function ArtifactsPage() {
    const session = await getValidatedServerSession();
    const sessionUserId = session?.user?.id;
    if (!sessionUserId) {
        redirect("/login");
    }

    const [membership] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, sessionUserId))
        .limit(1);

    if (!membership) {
        return <div className="p-8 text-zinc-400">Company not found.</div>;
    }

    const companyId = membership.companyId;
    const scope = session ? getScopeFromSession(session) : null;
    const scopedCustomerIds = getScopedCustomerIds(scope);

    const projectConditions: any[] = [eq(projects.companyId, companyId), isNull(projects.deletedAt)];
    if (scopedCustomerIds) projectConditions.push(inArray(projects.customerId, scopedCustomerIds));

    const projectOptions = await db.select({
        id: projects.id,
        name: projects.goal,
        customerId: projects.customerId,
    }).from(projects)
        .where(and(...projectConditions))
        .orderBy(projects.goal);

    const taskConditions: any[] = [eq(tasks.companyId, companyId), isNull(tasks.deletedAt)];
    if (scopedCustomerIds) {
        // Tasks linked to projects of visible customers
        const visibleProjectIds = projectOptions.map(p => p.id);
        if (visibleProjectIds.length > 0) {
            taskConditions.push(inArray(tasks.projectId, visibleProjectIds));
        } else {
            taskConditions.push(eq(tasks.id, "00000000-0000-0000-0000-000000000000")); // force empty
        }
    }

    const taskOptions = await db.select({
        id: tasks.id,
        type: tasks.taskType,
        projectId: tasks.projectId,
    }).from(tasks)
        .where(and(...taskConditions))
        .orderBy(tasks.taskType);

    const customerOptions = await db.select({
        id: customers.id,
        name: customers.name,
    }).from(customers)
        .where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt)))
        .orderBy(customers.name);

    return (
        <ArtifactsManager
            projects={projectOptions}
            tasks={taskOptions}
            customers={customerOptions}
        />
    );
}
