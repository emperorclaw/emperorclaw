import { IconAlertTriangle, IconCheck, IconPlayerPause, IconUsers } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import type { KpiFilter } from "@/lib/team-scene";
import { cn } from "@/lib/utils";

const KPIS: Array<{ id: KpiFilter; icon: typeof IconUsers; tone: string; tile: string; dot: string; ring: string }> = [
    { id: "working", icon: IconUsers, tone: "text-sky-500 dark:text-sky-300", tile: "bg-sky-500/10", dot: "bg-sky-400", ring: "ring-sky-400/60" },
    { id: "waiting", icon: IconPlayerPause, tone: "text-amber-500 dark:text-amber-300", tile: "bg-amber-500/10", dot: "bg-amber-400", ring: "ring-amber-400/60" },
    { id: "done", icon: IconCheck, tone: "text-emerald-500 dark:text-emerald-300", tile: "bg-emerald-500/10", dot: "bg-emerald-400", ring: "ring-emerald-400/60" },
    { id: "attention", icon: IconAlertTriangle, tone: "text-rose-500 dark:text-rose-300", tile: "bg-rose-500/10", dot: "bg-rose-400", ring: "ring-rose-400/60" },
];

export function KpiRow({ counts, active, onToggle }: { counts: Record<KpiFilter, number>; active: KpiFilter | null; onToggle: (id: KpiFilter) => void }) {
    const t = useTranslations("home.kpi");
    return (
        <div role="group" aria-label={t("filterLabel")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {KPIS.map((kpi) => {
                const on = active === kpi.id;
                return (
                    // The number on top, its label underneath (two lines at most, so a narrow tile keeps the whole label).
                    <button key={kpi.id} type="button" aria-pressed={on} onClick={() => onToggle(kpi.id)}
                        className={cn(
                            "emperor-panel group flex min-h-24 min-w-0 flex-col justify-between gap-2 rounded-2xl px-3 py-3 text-left transition-colors sm:px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            on && cn("ring-2", kpi.ring),
                        )}>
                        <span className="flex items-start justify-between gap-2">
                            <span className="text-2xl font-semibold leading-7 tabular-nums text-foreground">{counts[kpi.id]}</span>
                            <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", kpi.tile)}>
                                <kpi.icon className={cn("h-4 w-4", kpi.tone)} stroke={1.8} />
                            </span>
                        </span>
                        <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground sm:text-sm" title={t(kpi.id)}>
                            <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full", kpi.dot)} />
                            <span className="line-clamp-2 leading-snug">{t(kpi.id)}</span>
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
