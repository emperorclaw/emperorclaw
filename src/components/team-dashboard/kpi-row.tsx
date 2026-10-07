import { IconAlertTriangle, IconCheck, IconPlayerPause, IconUsers } from "@tabler/icons-react";
import type { KpiFilter } from "@/lib/team-scene";
import { cn } from "@/lib/utils";

const KPIS: Array<{ id: KpiFilter; label: string; icon: typeof IconUsers; tone: string; tile: string; dot: string; ring: string }> = [
    { id: "working", label: "working", icon: IconUsers, tone: "text-sky-500 dark:text-sky-300", tile: "bg-sky-500/10 ring-sky-500/30 shadow-[0_0_24px_-6px_rgba(56,189,248,0.55)]", dot: "bg-sky-400", ring: "ring-sky-400/60" },
    { id: "waiting", label: "waiting", icon: IconPlayerPause, tone: "text-amber-500 dark:text-amber-300", tile: "bg-amber-500/10 ring-amber-500/30 shadow-[0_0_24px_-6px_rgba(251,191,36,0.5)]", dot: "bg-amber-400", ring: "ring-amber-400/60" },
    { id: "done", label: "done in 24h", icon: IconCheck, tone: "text-emerald-500 dark:text-emerald-300", tile: "bg-emerald-500/10 ring-emerald-500/30 shadow-[0_0_24px_-6px_rgba(52,211,153,0.5)]", dot: "bg-emerald-400", ring: "ring-emerald-400/60" },
    { id: "attention", label: "need you", icon: IconAlertTriangle, tone: "text-rose-500 dark:text-rose-300", tile: "bg-rose-500/10 ring-rose-500/30 shadow-[0_0_24px_-6px_rgba(251,113,133,0.55)]", dot: "bg-rose-400", ring: "ring-rose-400/60" },
];

export function KpiRow({ counts, active, onToggle }: { counts: Record<KpiFilter, number>; active: KpiFilter | null; onToggle: (id: KpiFilter) => void }) {
    return (
        <div role="group" aria-label="Filter the workspace by status" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {KPIS.map((kpi) => {
                const on = active === kpi.id;
                return (
                    <button key={kpi.id} type="button" aria-pressed={on} onClick={() => onToggle(kpi.id)}
                        className={cn(
                            "emperor-panel group flex items-center gap-3.5 rounded-2xl px-4 py-3.5 text-left transition duration-200 hover:-translate-y-0.5 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
                            on && cn("ring-2", kpi.ring),
                        )}>
                        <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl ring-1 ring-inset", kpi.tile)}>
                            <kpi.icon className={cn("h-5 w-5", kpi.tone)} stroke={1.8} />
                        </span>
                        <span className="min-w-0">
                            <span className="block text-2xl font-semibold leading-7 tabular-nums text-foreground">{counts[kpi.id]}</span>
                            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                                <span className={cn("h-1.5 w-1.5 rounded-full", kpi.dot)} />{kpi.label}
                            </span>
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
