import { and, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { agents, customers, projects } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";
import { listScopedResources, resolveResourceScope } from "@/lib/resources";
import ResourcesClient from "./resources-client";

export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const [initialResources, customerRows, projectRows, agentRows] = await Promise.all([
        listScopedResources({ companyId }),
        db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.companyId, companyId)),
        db.select({ id: projects.id, goal: projects.goal }).from(projects).where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt))),
        db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
    ]);

    return (
        <ResourcesClient
            initialResources={initialResources.map((resource) => ({
                ...resource,
                configJson: resource.configJson && typeof resource.configJson === "object" && !Array.isArray(resource.configJson)
                    ? resource.configJson as Record<string, unknown>
                    : {},
                ...resolveResourceScope(resource),
                secretJson: undefined,
            }))}
            customers={customerRows}
            projects={projectRows.map((project) => ({ id: project.id, name: project.goal }))}
            agents={agentRows}
        />
    );
}
