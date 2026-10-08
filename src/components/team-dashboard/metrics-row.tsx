import Link from "next/link";
import { IconAlertTriangle, IconActivity, IconCircleCheck, IconClockHour4, IconCurrencyDollar, IconFlame } from "@tabler/icons-react";
import { budgetFraction, formatCents, isOverBudgetWarning, type CostSummary, type KpiFilter, type ThroughputSummary } from "@/lib/team-scene";
import { cn } from "@/lib/utils";

function cycleTimeLabel(ms: number | null): string {
    if (ms === null) return "—";
    const mins = ms / 60_000;
    if (mins < 1) return "under a minute";
    if (mins < 60) return `${Math.round(mins)}m`;
    const hours = mins / 60;
    if (hours < 24) return `${hours.toFixed(1)}h`;
    return `${(hours / 24).toFixed(1)}d`;
}

/** Inline sparkline (no library) for tasks-done-per-day. */
function Sparkline({ values }: { values: number[] }) {
    const w = 72;
    const h = 22;
    const max = Math.max(1, ...values);
    const step = values.length > 1 ? w / (values.length - 1) : w;
    const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`);
    return (
        <svg viewBox={`0 0 ${w} ${h}`} className="h-[22px] w-[72px] shrink-0" aria-hidden>
            <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400" />
        </svg>
    );
}

export function MetricsRow({ cost, throughput, onFilter }: {
    cost: CostSummary;
    throughput: ThroughputSummary;
    onFilter: (filter: KpiFilter) => void;
}) {
    const budgetPct = budgetFraction(cost.spendMonthCents, cost.budgetCents);
    const overBudget = cost.agents.some((a) => isOverBudgetWarning(a.monthCents, a.budgetCents));

    return (
        <section aria-label="Cost and throughput" className="emperor-panel rounded-2xl p-4">
            <div className="grid gap-4 lg:grid-cols-2">
                {/* Cost */}
                <div className="min-w-0">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <IconCurrencyDollar className="h-4 w-4 text-emerald-500 dark:text-emerald-300" stroke={1.8} /> Spend
                        {overBudget && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-rose-500/12 px-1.5 py-0.5 text-[10px] font-bold text-rose-600 ring-1 ring-inset ring-rose-500/30 dark:text-rose-300">
                                <IconAlertTriangle className="h-3 w-3" /> over budget
                            </span>
                        )}
                    </h2>
                    <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                        <span className="text-2xl font-semibold leading-7 tabular-nums text-foreground">{formatCents(cost.spendTodayCents) ?? "—"}</span>
                        <span className="text-sm text-muted-foreground">last 24h</span>
                        <span className="text-sm tabular-nums text-foreground/80">{formatCents(cost.spendMonthCents) ?? "—"} <span className="text-muted-foreground">this month</span></span>
                    </div>
                    {budgetPct !== null && (
                        <div className="mt-2">
                            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                                <span>monthly budget</span>
                                <span className="tabular-nums">{formatCents(cost.budgetCents)} · {Math.round(budgetPct * 100)}%</span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted dark:bg-white/10">
                                <div className={cn("h-full rounded-full", budgetPct >= 1 ? "bg-rose-500" : budgetPct > 0.8 ? "bg-amber-400" : "bg-emerald-400")} style={{ width: `${Math.min(100, budgetPct * 100)}%` }} />
                            </div>
                        </div>
                    )}
                    {cost.agents.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            {cost.agents.slice(0, 3).map((a) => (
                                <span key={a.key} className="inline-flex items-center gap-1">
                                    <span className={cn("h-1.5 w-1.5 rounded-full", isOverBudgetWarning(a.monthCents, a.budgetCents) ? "bg-rose-400" : "bg-emerald-400")} />
                                    {a.name} <span className="tabular-nums text-foreground/80">{formatCents(a.monthCents)}</span>
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                {/* Throughput */}
                <div className="min-w-0">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <IconActivity className="h-4 w-4 text-sky-500 dark:text-sky-300" stroke={1.8} /> Throughput
                    </h2>
                    <div className="mt-2 grid grid-cols-3 gap-3">
                        <button type="button" onClick={() => onFilter("done")} className="group rounded-xl border border-border/70 bg-muted/30 p-2.5 text-left transition hover:border-border hover:bg-muted/60 dark:bg-white/[0.02]">
                            <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><IconCircleCheck className="h-3.5 w-3.5 text-emerald-500" />done · 24h</div>
                            <div className="mt-1 flex items-baseline gap-2">
                                <span className="text-xl font-semibold leading-6 tabular-nums text-foreground">{throughput.doneToday}</span>
                                <span className="text-xs text-muted-foreground">{throughput.doneThisWeek} this week</span>
                            </div>
                            <div className="mt-1 text-emerald-400"><Sparkline values={throughput.sparkline} /></div>
                        </button>
                        <div className="rounded-xl border border-border/70 bg-muted/30 p-2.5 dark:bg-white/[0.02]">
                            <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><IconClockHour4 className="h-3.5 w-3.5 text-sky-500" />cycle time</div>
                            <div className="mt-1 text-xl font-semibold leading-6 tabular-nums text-foreground">{cycleTimeLabel(throughput.medianCycleMs)}</div>
                            <div className="mt-1 text-[11px] text-muted-foreground">assigned → done, 7d</div>
                        </div>
                        <Link href="/projects?attention=1" className="group rounded-xl border border-border/70 bg-muted/30 p-2.5 text-left transition hover:border-border hover:bg-muted/60 dark:bg-white/[0.02]">
                            <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><IconFlame className="h-3.5 w-3.5 text-rose-500" />blocked</div>
                            <div className="mt-1 text-xl font-semibold leading-6 tabular-nums text-foreground">{throughput.blocked}</div>
                            <div className="mt-1 text-[11px] text-muted-foreground">failed tasks · open board</div>
                        </Link>
                    </div>
                </div>
            </div>
        </section>
    );
}
