import { desc, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { runtimeNodes } from "@/db/schema";
import { getTranslations } from "next-intl/server";
import { OpsSection, OpsTable, getOpsFormat } from "../ui";

export const dynamic = "force-dynamic";

export default async function OpsRuntimesPage() {
    const rows = await db.select({
        id: runtimeNodes.id,
        runtimeId: runtimeNodes.runtimeId,
        name: runtimeNodes.name,
        hostname: runtimeNodes.hostname,
        gatewayVersion: runtimeNodes.gatewayVersion,
        status: runtimeNodes.status,
        lastSeenAt: runtimeNodes.lastSeenAt,
        startedAt: runtimeNodes.startedAt,
        companyId: runtimeNodes.companyId,
        companyName: sql<string | null>`(
            select name
            from companies
            where companies.id = ${runtimeNodes.companyId}
            limit 1
        )`,
        recentSessionCount: sql<number>`(
            select count(*)
            from agent_sessions
            where agent_sessions.runtime_node_id = ${runtimeNodes.id}
              and agent_sessions.started_at >= now() - interval '7 days'
        )`,
        lastProvisionError: sql<string | null>`(
            select agent_sessions.last_provision_error
            from agent_sessions
            where agent_sessions.runtime_node_id = ${runtimeNodes.id}
              and agent_sessions.last_provision_error is not null
            order by agent_sessions.created_at desc
            limit 1
        )`,
    }).from(runtimeNodes).where(isNull(runtimeNodes.deletedAt)).orderBy(desc(runtimeNodes.lastSeenAt));
    const [t, format] = await Promise.all([getTranslations("ops"), getOpsFormat()]);
    const formatDateTime = format.dateTime;

    return (
        <OpsSection
            title={t("runtimes.title")}
            description={t("runtimes.description")}
        >
            <OpsTable headers={[t("columns.runtime"), t("columns.company"), t("columns.status"), t("columns.lastSeen"), t("columns.started"), t("columns.sessions7d"), t("columns.lastProvisionError")]} empty={t("runtimes.empty")}>
                {rows.map((runtime) => (
                    <tr key={runtime.id} className="align-top">
                        <td className="px-4 py-3">
                            <div className="font-medium text-zinc-200">{runtime.name}</div>
                            <div className="text-xs text-zinc-500">{runtime.runtimeId}</div>
                            <div className="text-xs text-zinc-600">{runtime.hostname || t("runtimes.noHostname")}</div>
                        </td>
                        <td className="px-4 py-3 text-zinc-400">
                            <div>{runtime.companyName || t("unknown")}</div>
                            <div className="text-xs text-zinc-600">{runtime.companyId}</div>
                        </td>
                        <td className="px-4 py-3">
                            <span className={`rounded border px-2 py-1 text-xs uppercase tracking-wider ${
                                runtime.status === "active"
                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                    : "border-amber-500/30 bg-amber-500/10 text-amber-300"
                            }`}>
                                {runtime.status}
                            </span>
                        </td>
                        <td className="px-4 py-3 text-zinc-400">{formatDateTime(runtime.lastSeenAt)}</td>
                        <td className="px-4 py-3 text-zinc-400">{formatDateTime(runtime.startedAt)}</td>
                        <td className="px-4 py-3 text-zinc-400">{runtime.recentSessionCount}</td>
                        <td className="px-4 py-3 text-zinc-400">
                            {runtime.lastProvisionError ? (
                                <div className="max-w-sm text-amber-300">{runtime.lastProvisionError}</div>
                            ) : (
                                t("none")
                            )}
                        </td>
                    </tr>
                ))}
            </OpsTable>
        </OpsSection>
    );
}
