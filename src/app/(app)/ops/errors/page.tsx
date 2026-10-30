import { desc } from "drizzle-orm";
import { db } from "@/db";
import { opsEvents } from "@/db/schema";
import { getTranslations } from "next-intl/server";
import { OpsSection, OpsTable, getOpsFormat } from "../ui";

export const dynamic = "force-dynamic";

export default async function OpsErrorsPage() {
    const rows = await db.select().from(opsEvents).orderBy(desc(opsEvents.createdAt)).limit(200);
    const [t, format] = await Promise.all([getTranslations("ops"), getOpsFormat()]);
    const formatDateTime = format.dateTime;

    return (
        <OpsSection
            title={t("errors.title")}
            description={t("errors.description")}
        >
            <OpsTable headers={[t("columns.when"), t("columns.level"), t("columns.source"), t("columns.route"), t("columns.message"), t("columns.context")]} empty={t("noEvents")}>
                {rows.map((event) => (
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
                        <td className="px-4 py-3">
                            <div className="text-zinc-200">{event.source}</div>
                            <div className="text-xs text-zinc-500">{event.category}</div>
                        </td>
                        <td className="px-4 py-3 text-zinc-400">
                            {event.method && event.route ? `${event.method} ${event.route}` : event.route || t("notApplicable")}
                        </td>
                        <td className="px-4 py-3">
                            <div className="max-w-md text-zinc-300">{event.message}</div>
                            {event.stack ? (
                                <details className="mt-2">
                                    <summary className="cursor-pointer text-xs text-zinc-500">{t("errors.stack")}</summary>
                                    <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 text-xs text-zinc-400">{event.stack}</pre>
                                </details>
                            ) : null}
                        </td>
                        <td className="px-4 py-3">
                            <div className="space-y-1 text-xs text-zinc-500">
                                {event.companyId ? <div>{t("errors.companyId", { id: event.companyId })}</div> : null}
                                {event.userId ? <div>{t("errors.userId", { id: event.userId })}</div> : null}
                            </div>
                            {event.metadataJson && Object.keys(event.metadataJson as Record<string, unknown>).length > 0 ? (
                                <pre className="mt-2 max-w-sm whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 text-xs text-zinc-400">
                                    {JSON.stringify(event.metadataJson, null, 2)}
                                </pre>
                            ) : null}
                        </td>
                    </tr>
                ))}
            </OpsTable>
        </OpsSection>
    );
}
