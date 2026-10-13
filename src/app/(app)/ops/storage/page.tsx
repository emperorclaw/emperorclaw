import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getRecentRetentionRuns } from "@/lib/retention";
import { OpsCard, OpsSection, OpsTable, formatDateTime } from "../ui";

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
    const largest = tables[0];
    const lastRun = retentionRuns[0];
    const lastRunDeleted = lastRun
        ? lastRun.steps.reduce((sum, step) => sum + step.deleted, 0)
        : 0;

    return (
        <div className="space-y-8 pb-12">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <OpsCard
                    title="Database size"
                    value={formatBytes(totalDbBytes)}
                    detail="On-disk size of the current database (pg_database_size)"
                />
                <OpsCard
                    title="Tables sized"
                    value={String(tables.length)}
                    detail={`Largest ${TOP_TABLES} tables by total relation size`}
                />
                <OpsCard
                    title="Largest table"
                    value={largest ? formatBytes(largest.totalBytes) : "—"}
                    detail={largest ? largest.table : "No tables found"}
                />
                <OpsCard
                    title="Last retention"
                    value={lastRun ? String(lastRunDeleted) : "—"}
                    detail={lastRun ? `Rows deleted ${formatDateTime(lastRun.startedAt)}` : "No retention run recorded yet"}
                />
            </div>

            <OpsSection
                title="Top Tables by Size"
                description="Total relation size (table + indexes + TOAST) with the planner's estimated row count."
            >
                <OpsTable headers={["Table", "Total size", "Estimated rows"]} empty="No tables found.">
                    {tables.map((row) => (
                        <tr key={row.table}>
                            <td className="px-4 py-3 font-mono text-zinc-200">{row.table}</td>
                            <td className="px-4 py-3 text-zinc-300">{formatBytes(row.totalBytes)}</td>
                            <td className="px-4 py-3 text-zinc-400">{row.estRows.toLocaleString()}</td>
                        </tr>
                    ))}
                </OpsTable>
            </OpsSection>

            <OpsSection
                title="Recent Retention Runs"
                description="The last few cleanup passes: when they ran, how long they took, and what each step deleted."
            >
                <OpsTable
                    headers={["Started", "Duration", "Rows deleted", "Per step"]}
                    empty="No retention run recorded yet."
                >
                    {retentionRuns.slice(0, 10).map((run) => {
                        const total = run.steps.reduce((sum, step) => sum + step.deleted, 0);
                        const detail = run.steps
                            .map((step) => `${step.table}: ${step.deleted.toLocaleString()}${step.exhausted ? " (budget)" : ""}${step.error ? " (error)" : ""}`)
                            .join(" · ");
                        return (
                            <tr key={`${run.startedAt}-${total}`} className="align-top">
                                <td className="px-4 py-3 text-zinc-300">{formatDateTime(run.startedAt)}</td>
                                <td className="px-4 py-3 text-zinc-400">{formatDuration(run.durationMs)}</td>
                                <td className="px-4 py-3 text-zinc-200">{total.toLocaleString()}</td>
                                <td className="px-4 py-3 text-zinc-500">{detail || "—"}</td>
                            </tr>
                        );
                    })}
                </OpsTable>
            </OpsSection>
        </div>
    );
}
