import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getRecentRetentionRuns } from "@/lib/retention";
import { getTranslations } from "next-intl/server";
import { OpsCard, OpsSection, OpsTable, getOpsFormat } from "../ui";

export const dynamic = "force-dynamic";

/** Top tables by total relation size (indexes and TOAST included). */
const TOP_TABLES = 15;

interface RawTableSize {
    table_name: string;
    total_bytes: string | number;
    est_rows: string | number;
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / 1024 ** exponent;
    const decimals = exponent === 0 || value >= 10 ? 0 : 1;
    return `${value.toFixed(decimals)} ${units[exponent]}`;
}

function formatDuration(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export default async function OpsStoragePage() {
    const [sizeResult, dbSizeResult, retentionRuns] = await Promise.all([
        db.execute(sql`
            SELECT c.relname AS table_name,
                   pg_total_relation_size(c.oid) AS total_bytes,
                   GREATEST(c.reltuples, 0)::bigint AS est_rows
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'r' AND n.nspname = 'public'
            ORDER BY pg_total_relation_size(c.oid) DESC
            LIMIT ${TOP_TABLES}
        `),
        db.execute(sql`SELECT pg_database_size(current_database()) AS db_bytes`),
        getRecentRetentionRuns(),
    ]);

    const tables = (sizeResult.rows as unknown as RawTableSize[]).map((row) => ({
        table: row.table_name,
        totalBytes: Number(row.total_bytes),
        estRows: Number(row.est_rows),
    }));
    const totalDbBytes = Number(
        (dbSizeResult.rows[0] as unknown as { db_bytes: string | number } | undefined)?.db_bytes ?? 0,
    );
    const [t, format] = await Promise.all([getTranslations("ops.storage"), getOpsFormat()]);
    const formatDateTime = format.dateTime;
    const largest = tables[0];
    const lastRun = retentionRuns[0];
    const lastRunDeleted = lastRun
        ? lastRun.steps.reduce((sum, step) => sum + step.deleted, 0)
        : 0;

    return (
        <div className="space-y-8 pb-12">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <OpsCard
                    title={t("databaseSize")}
                    value={formatBytes(totalDbBytes)}
                    detail={t("databaseSizeDetail")}
                />
                <OpsCard
                    title={t("tablesSized")}
                    value={String(tables.length)}
                    detail={t("tablesSizedDetail", { count: TOP_TABLES })}
                />
                <OpsCard
                    title={t("largestTable")}
                    value={largest ? formatBytes(largest.totalBytes) : "—"}
                    detail={largest ? largest.table : t("noTables")}
                />
                <OpsCard
                    title={t("lastRetention")}
                    value={lastRun ? String(lastRunDeleted) : "—"}
                    detail={lastRun ? t("rowsDeletedAt", { when: formatDateTime(lastRun.startedAt) }) : t("noRetention")}
                />
            </div>

            <OpsSection
                title={t("topTables")}
                description={t("topTablesDescription")}
            >
                <OpsTable headers={[t("columns.table"), t("columns.totalSize"), t("columns.estimatedRows")]} empty={t("noTablesPeriod")}>
                    {tables.map((row) => (
                        <tr key={row.table}>
                            <td className="px-4 py-3 font-mono text-zinc-200">{row.table}</td>
                            <td className="px-4 py-3 text-zinc-300">{formatBytes(row.totalBytes)}</td>
                            <td className="px-4 py-3 text-zinc-400">{format.number(row.estRows)}</td>
                        </tr>
                    ))}
                </OpsTable>
            </OpsSection>

            <OpsSection
                title={t("recentRuns")}
                description={t("recentRunsDescription")}
            >
                <OpsTable
                    headers={[t("columns.started"), t("columns.duration"), t("columns.rowsDeleted"), t("columns.perStep")]}
                    empty={t("noRetentionPeriod")}
                >
                    {retentionRuns.slice(0, 10).map((run) => {
                        const total = run.steps.reduce((sum, step) => sum + step.deleted, 0);
                        const detail = run.steps
                            .map((step) => `${step.table}: ${format.number(step.deleted)}${step.exhausted ? ` ${t("budget")}` : ""}${step.error ? ` ${t("error")}` : ""}`)
                            .join(" · ");
                        return (
                            <tr key={`${run.startedAt}-${total}`} className="align-top">
                                <td className="px-4 py-3 text-zinc-300">{formatDateTime(run.startedAt)}</td>
                                <td className="px-4 py-3 text-zinc-400">{formatDuration(run.durationMs)}</td>
                                <td className="px-4 py-3 text-zinc-200">{format.number(total)}</td>
                                <td className="px-4 py-3 text-zinc-500">{detail || "—"}</td>
                            </tr>
                        );
                    })}
                </OpsTable>
            </OpsSection>
        </div>
    );
}
