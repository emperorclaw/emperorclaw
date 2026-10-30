import { desc, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { getTranslations } from "next-intl/server";
import { OpsSection, OpsTable, getOpsFormat } from "../ui";

export const dynamic = "force-dynamic";

export default async function OpsCompaniesPage() {
    const rows = await db.select({
        id: companies.id,
        name: companies.name,
        createdAt: companies.createdAt,
        creatorEmail: sql<string | null>`(
            select email
            from users
            where users.id = ${companies.createdByUserId}
            limit 1
        )`,
        memberCount: sql<number>`(
            select count(*)
            from company_members
            where company_members.company_id = ${companies.id}
        )`,
        agentCount: sql<number>`(
            select count(*)
            from agents
            where agents.company_id = ${companies.id}
              and agents.deleted_at is null
        )`,
        runtimeCount: sql<number>`(
            select count(*)
            from runtime_nodes
            where runtime_nodes.company_id = ${companies.id}
              and runtime_nodes.deleted_at is null
              and runtime_nodes.status = 'active'
        )`,
    }).from(companies).where(isNull(companies.deletedAt)).orderBy(desc(companies.createdAt));
    const [t, format] = await Promise.all([getTranslations("ops"), getOpsFormat()]);
    const formatDateOnly = format.dateOnly;

    return (
        <OpsSection
            title={t("companies.title")}
            description={t("companies.description")}
        >
            <OpsTable headers={[t("columns.company"), t("columns.created"), t("columns.createdBy"), t("columns.members"), t("columns.agents"), t("columns.activeRuntimes")]} empty={t("companies.empty")}>
                {rows.map((company) => (
                    <tr key={company.id}>
                        <td className="px-4 py-3">
                            <div className="font-medium text-zinc-200">{company.name}</div>
                            <div className="text-xs text-zinc-500">{company.id}</div>
                        </td>
                        <td className="px-4 py-3 text-zinc-400">{formatDateOnly(company.createdAt)}</td>
                        <td className="px-4 py-3 text-zinc-400">{company.creatorEmail || t("unknown")}</td>
                        <td className="px-4 py-3 text-zinc-400">{company.memberCount}</td>
                        <td className="px-4 py-3 text-zinc-400">{company.agentCount}</td>
                        <td className="px-4 py-3 text-zinc-400">{company.runtimeCount}</td>
                    </tr>
                ))}
            </OpsTable>
        </OpsSection>
    );
}
