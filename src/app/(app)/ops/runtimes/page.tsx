import { desc, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { runtimeNodes } from "@/db/schema";
import { OpsSection, OpsTable, formatDateTime } from "../ui";

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

    return (
        <OpsSection
            title="Runtimes"
            description="Runtime nodes, heartbeat freshness, recent session volume, and latest provisioning failures."
        >
            <OpsTable headers={["Runtime", "Company", "Status", "Last Seen", "Started", "Sessions (7d)", "Last Provision Error"]} empty="No runtimes found.">
                {rows.map((runtime) => (
                    <tr key={runtime.id} className="align-top">
                        <td className="px-4 py-3">
                            <div className="font-medium text-zinc-200">{runtime.name}</div>
                            <div className="text-xs text-zinc-500">{runtime.runtimeId}</div>
                            <div className="text-xs text-zinc-600">{runtime.hostname || "no hostname"}</div>
                        </td>
                        <td className="px-4 py-3 text-zinc-400">
                            <div>{runtime.companyName || "Unknown"}</div>
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
                                "None"
                            )}
                        </td>
                    </tr>
                ))}
            </OpsTable>
        </OpsSection>
    );
}
