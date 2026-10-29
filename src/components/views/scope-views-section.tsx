"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { IconLayoutDashboard } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import type { ViewSummary } from "@/lib/views";
import { ViewRow } from "./view-meta";
import { useNowMs } from "./view-panels";

/**
 * The views of one client (its own and its projects') or one project, on the
 * client and project pages. Reads /api/views, so it shows exactly what the
 * Views list would; renders nothing while the Views module is off.
 */
export function ScopeViewsSection({ customerId, projectId, className, hideWhenEmpty = false }: {
    customerId?: string;
    projectId?: string;
    className?: string;
    /** The project board keeps its space for tasks: no section at all without views. */
    hideWhenEmpty?: boolean;
}) {
    const t = useTranslations("views");
    const now = useNowMs();
    const [views, setViews] = useState<ViewSummary[] | null>(null);
    const [hidden, setHidden] = useState(false);
    const query = customerId ? `customer=${encodeURIComponent(customerId)}` : projectId ? `scopeType=project&scopeId=${encodeURIComponent(projectId)}` : null;

    useEffect(() => {
        if (!query) return;
        // Callers key this component by the scope id, so a new scope starts from null.
        let alive = true;
        fetch(`/api/views?${query}`).then(async (res) => {
            if (!alive) return;
            if (!res.ok) { setHidden(true); return; }
            setHidden(false);
            setViews(((await res.json()) as { views: ViewSummary[] }).views);
        }).catch(() => { if (alive) setHidden(true); });
        return () => { alive = false; };
    }, [query]);

    if (!query || hidden || (hideWhenEmpty && (views === null || views.length === 0))) return null;
    return (
        <section aria-labelledby={`scope-views-${customerId ?? projectId}`} className={className}>
            <div className="mb-2 flex items-baseline justify-between gap-3">
                <h3 id={`scope-views-${customerId ?? projectId}`} className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <IconLayoutDashboard className="h-4 w-4 text-muted-foreground" aria-hidden />{t("title")}
                </h3>
                <Link href="/views" className="text-xs text-muted-foreground hover:text-foreground">{t("allViews")}</Link>
            </div>
            {views === null ? (
                <p className="rounded-xl border border-border bg-card px-3 py-3 text-sm text-muted-foreground">{t("loading")}</p>
            ) : views.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border bg-card px-3 py-3 text-sm text-muted-foreground">
                    {t("scopeEmpty", { scope: customerId ? "customer" : "project" })}
                </p>
            ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                    {views.map((view) => <ViewRow key={view.id} view={view} now={now} showScope={Boolean(customerId)} />)}
                </ul>
            )}
        </section>
    );
}
