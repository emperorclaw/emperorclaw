import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { customers, projects } from "@/db/schema";
import { requireCompanyAccess } from "@/lib/company-access";
import { canWrite } from "@/lib/role-matrix";
import { getScopedCustomerIds, memberVisibleProjectIds } from "@/lib/member-scope";
import { splitProjectTitle } from "@/lib/project-title";
import { listViews, memberViewCaller } from "@/lib/views";
import { PageHeader } from "@/components/page-header";
import { RealtimeRefresh } from "@/lib/use-realtime";
import { NewViewButton, ViewsBrowser } from "./views-client";

export const dynamic = "force-dynamic";

/**
 * Views (roadmap 0.15): dashboards agents build and keep up to date, grouped
 * by scope (company, then each client with its projects). Each person sees
 * what lib/view-access.ts allows: views open to their scope, their own and
 * those shared with them; owners/admins also see other private views by name
 * only. Members and up can start one.
 */
export default async function ViewsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
    const access = await requireCompanyAccess("viewer").catch(() => null);
    if (!access) redirect("/login");
    const showArchived = (await searchParams).archived === "1";
    const all = await listViews(access.companyId, memberViewCaller(access), { includeArchived: showArchived });
    const rows = showArchived ? all.filter((view) => view.archived) : all;
    const canEdit = canWrite(access.role);
    const scopes = canEdit ? await loadScopeOptions(access.companyId, access.scope) : { customers: [], projects: [] };
    const t = await getTranslations("views.list");

    return (
        <div className="mx-auto max-w-[1400px] space-y-6 animate-in fade-in duration-500">
            <PageHeader
                eyebrow={t("eyebrow")}
                title={showArchived ? t("archivedTitle") : t("title")}
                description={t("description")}
                actions={canEdit && !showArchived ? <NewViewButton customers={scopes.customers} projects={scopes.projects} /> : undefined}
            />
            <ViewsBrowser views={rows} showArchived={showArchived} userId={access.userId} />
            <RealtimeRefresh topics={["views"]} />
        </div>
    );
}

/** Customers and projects a person may file a view under (their scope only). */
async function loadScopeOptions(companyId: string, scope: Awaited<ReturnType<typeof requireCompanyAccess>>["scope"]) {
    const customerIds = getScopedCustomerIds(scope);
    const projectIds = await memberVisibleProjectIds(companyId, scope);
    const [customerRows, projectRows] = await Promise.all([
        customerIds && customerIds.length === 0 ? Promise.resolve([]) : db.select({ id: customers.id, name: customers.name }).from(customers)
            .where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt), customerIds ? inArray(customers.id, customerIds) : undefined))
            .orderBy(asc(customers.name)).limit(500),
        projectIds && projectIds.size === 0 ? Promise.resolve([]) : db.select({ id: projects.id, goal: projects.goal }).from(projects)
            .where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt), projectIds ? inArray(projects.id, [...projectIds]) : undefined))
            .orderBy(asc(projects.goal)).limit(500),
    ]);
    return {
        customers: customerRows.map((c) => ({ id: c.id, name: c.name })),
        projects: projectRows.map((p) => ({ id: p.id, name: splitProjectTitle(p.goal).name })),
    };
}
