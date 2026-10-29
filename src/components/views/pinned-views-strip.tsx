"use client";

import Link from "next/link";
import { IconLayoutDashboard } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { formatChartValue } from "@/lib/rich-blocks";
import type { MetricPanelData, ProgressPanelData } from "@/lib/view-spec";
import type { PinnedViewCard } from "@/lib/views";
import { viewStaleness } from "@/lib/view-access";
import { StaleNote } from "./view-meta";
import { useFormatAgo, useNowMs } from "./view-panels";

function headline(item: PinnedViewCard["highlights"][number]): string {
    if (item.type === "progress") {
        const data = item.data as ProgressPanelData;
        return `${Math.round(Math.max(0, Math.min(1, data.value / data.max)) * 100)}%`;
    }
    const data = item.data as MetricPanelData;
    return typeof data.value === "number" ? formatChartValue(data.value, "", data.unit ?? "", true) : `${data.value}${data.unit ? ` ${data.unit}` : ""}`;
}

/** Home: the views this person pinned, compact (title plus up to three headline numbers). */
export function PinnedViewsStrip({ views }: { views: PinnedViewCard[] }) {
    const t = useTranslations("views");
    const formatAgo = useFormatAgo();
    const now = useNowMs();
    if (views.length === 0) return null;
    return (
        <section aria-labelledby="pinned-views-heading" className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
                <h2 id="pinned-views-heading" className="text-sm font-semibold text-foreground">{t("pinnedViews")}</h2>
                <Link href="/views" className="text-xs text-muted-foreground hover:text-foreground">{t("allViews")}</Link>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {views.map((view) => (
                    <Link key={view.id} href={`/views/${view.id}`} className="group min-w-0 rounded-2xl border border-border bg-card p-3.5 transition-colors hover:bg-accent/60">
                        <div className="flex items-center gap-2">
                            <IconLayoutDashboard className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="truncate text-sm font-medium text-foreground">{view.title}</span>
                        </div>
                        {view.highlights.length > 0 ? (
                            <dl className="mt-2 grid grid-cols-3 gap-2">
                                {view.highlights.map((item) => (
                                    <div key={item.id} className="min-w-0">
                                        <dt className="truncate text-[11px] text-muted-foreground">{item.title}</dt>
                                        <dd className="truncate text-base font-semibold text-foreground tabular-nums">{headline(item)}</dd>
                                    </div>
                                ))}
                            </dl>
                        ) : (
                            <p className="mt-2 text-xs text-muted-foreground">{t("row.panels", { count: view.panelCount })}</p>
                        )}
                        {viewStaleness({ lastAt: view.dataUpdatedAt, since: view.createdAt, refreshEveryMinutes: view.refreshEveryMinutes }, now).overdue ? (
                            <StaleNote lastAt={view.dataUpdatedAt} since={view.createdAt} refreshEveryMinutes={view.refreshEveryMinutes} now={now} className="mt-2 max-w-full text-[11px]" />
                        ) : (
                            <p className="mt-2 truncate text-[11px] text-muted-foreground" suppressHydrationWarning>
                                {view.dataUpdatedAt ? t("row.updated", { ago: formatAgo(view.dataUpdatedAt, now) }) : t("noValuesYet")}
                            </p>
                        )}
                    </Link>
                ))}
            </div>
        </section>
    );
}
