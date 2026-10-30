import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, companies, opsEvents, runtimeNodes, users } from "@/db/schema";
import { getTranslations } from "next-intl/server";
import { OpsCard, OpsSection, OpsTable, getOpsFormat } from "./ui";
import { UpdatePanel } from "@/components/update-panel";

export const dynamic = "force-dynamic";

export default async function OpsOverviewPage() {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
        [{ count: totalUsers }],
        [{ count: verifiedUsers }],
        [{ count: totalCompanies }],
        [{ count: totalAgents }],
        [{ count: activeRuntimes }],
        [{ count: errorsLast24h }],
        recentErrors,
        recentUsers,
    ] = await Promise.all([
        db.select({ count: sql<number>`count(*)` }).from(users).where(isNull(users.deletedAt)),
        db.select({ count: sql<number>`count(*)` }).from(users).where(and(isNull(users.deletedAt), sql`${users.emailVerifiedAt} is not null`)),
        db.select({ count: sql<number>`count(*)` }).from(companies).where(isNull(companies.deletedAt)),
        db.select({ count: sql<number>`count(*)` }).from(agents).where(isNull(agents.deletedAt)),
        db.select({ count: sql<number>`count(*)` }).from(runtimeNodes).where(and(isNull(runtimeNodes.deletedAt), eq(runtimeNodes.status, "active"))),
        db.select({ count: sql<number>`count(*)` }).from(opsEvents).where(and(eq(opsEvents.level, "error"), gte(opsEvents.createdAt, last24h))),
        db.select().from(opsEvents).orderBy(desc(opsEvents.createdAt)).limit(10),
        db.select({
            id: users.id,
            email: users.email,
            createdAt: users.createdAt,
            emailVerifiedAt: users.emailVerifiedAt,
        }).from(users).where(isNull(users.deletedAt)).orderBy(desc(users.createdAt)).limit(8),
    ]);

    const verificationRate = totalUsers > 0 ? Math.round((verifiedUsers / totalUsers) * 100) : 0;
    const [t, format] = await Promise.all([getTranslations("ops"), getOpsFormat()]);
    const formatDateTime = format.dateTime;

    return (
        <div className="space-y-8 pb-12">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                <OpsCard title={t("overview.users")} value={String(totalUsers)} detail={t("overview.usersDetail", { verified: verifiedUsers, rate: verificationRate })} />
                <OpsCard title={t("overview.companies")} value={String(totalCompanies)} detail={t("overview.companiesDetail")} />
                <OpsCard title={t("overview.agents")} value={String(totalAgents)} detail={t("overview.agentsDetail")} />
                <OpsCard title={t("overview.activeRuntimes")} value={String(activeRuntimes)} detail={t("overview.activeRuntimesDetail")} />
                <OpsCard title={t("overview.errors")} value={String(errorsLast24h)} detail={t("overview.errorsDetail")} />
                <OpsCard title={t("overview.signups")} value={String(recentUsers.length)} detail={t("overview.signupsDetail")} />
            </div>

            <UpdatePanel />

            <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
                <OpsSection
                    title={t("overview.recentErrors")}
                    description={t("overview.recentErrorsDescription")}
                    actionHref="/ops/errors"
                    actionLabel={t("overview.openErrors")}
                >
                    <OpsTable headers={[t("columns.when"), t("columns.level"), t("columns.source"), t("columns.message")]} empty={t("noEvents")}>
                        {recentErrors.map((event) => (
                            <tr key={event.id} className="align-top">
                                <td className="px-4 py-3 text-zinc-400">{formatDateTime(event.createdAt)}</td>
                                <td className="px-4 py-3">
                                    <span className={`rounded border px-2 py-1 text-xs uppercase tracking-wider ${
                                        event.level === "error"
                                            ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
                                            : event.level === "warn"
                                                ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                                                : "border-zinc-700 bg-zinc-800/60 text-zinc-300"
                                    }`}>
                                        {event.level}
                                    </span>
                                </td>
                                <td className="px-4 py-3 text-zinc-300">{event.source}</td>
                                <td className="px-4 py-3 text-zinc-400">{event.message}</td>
                            </tr>
                        ))}
                    </OpsTable>
                </OpsSection>

                <OpsSection
                    title={t("overview.newestUsers")}
                    description={t("overview.newestUsersDescription")}
                    actionHref="/ops/users"
                    actionLabel={t("overview.openUsers")}
                >
                    <OpsTable headers={[t("columns.email"), t("columns.created"), t("columns.verified")]} empty={t("noUsers")}>
                        {recentUsers.map((user) => (
                            <tr key={user.id}>
                                <td className="px-4 py-3 text-zinc-200">{user.email}</td>
                                <td className="px-4 py-3 text-zinc-400">{formatDateTime(user.createdAt)}</td>
                                <td className="px-4 py-3 text-zinc-400">
                                    {user.emailVerifiedAt ? (
                                        <span className="text-emerald-300">{t("verified")}</span>
                                    ) : (
                                        <span className="text-amber-300">{t("pending")}</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </OpsTable>
                </OpsSection>
            </div>
        </div>
    );
}
