import { and, eq, isNull, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { agents, customers, projects } from "@/db/schema";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { getScopeFromSession, getScopedAgentIds, getScopedCustomerIds } from "@/lib/member-scope";
import { listScopedResources, resolveResourceScope } from "@/lib/resources";
import ResourcesClient from "./resources-client";

export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const session = await getValidatedServerSession();
    const scope = session ? getScopeFromSession(session) : null;
    const scopedAgentIds = getScopedAgentIds(scope);
    const scopedCustomerIds = getScopedCustomerIds(scope);

    const [initialResources, customerRows, projectRows, agentRows] = await Promise.all([
        listScopedResources({ companyId }),
        scopedCustomerIds
            ? db.select({ id: customers.id, name: customers.name }).from(customers).where(and(eq(customers.companyId, companyId), inArray(customers.id, scopedCustomerIds)))
            : db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.companyId, companyId)),
        db.select({ id: projects.id, goal: projects.goal }).from(projects).where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt))),
        scopedAgentIds
            ? db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt), inArray(agents.id, scopedAgentIds)))
            : db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
    ]);

    return (
        <ResourcesClient
            initialResources={initialResources.map((resource) => ({
                ...resource,
                ...resolveResourceScope(resource),
                secretText: resource.secretText || "",
            }))}
            customers={customerRows}
            projects={projectRows.map((project) => ({ id: project.id, name: project.goal }))}
            agents={agentRows}
        />
    );
}
