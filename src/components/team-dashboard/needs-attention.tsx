import Link from "next/link";
import { IconAlertTriangle, IconChevronRight, IconCircleCheck, IconClock, IconFileText, IconMessageCircle, IconPlugConnectedX } from "@tabler/icons-react";
import { timeAgo, type AttentionEntry, type AttentionKind } from "@/lib/team-scene";
import { cn } from "@/lib/utils";

const KIND_STYLE: Record<AttentionKind, { icon: typeof IconFileText; tile: string }> = {
    approval: { icon: IconFileText, tile: "bg-sky-500/10 text-sky-500 ring-sky-500/25 dark:text-sky-300" },
    message: { icon: IconMessageCircle, tile: "bg-amber-500/10 text-amber-600 ring-amber-500/25 dark:text-amber-300" },
    incident: { icon: IconAlertTriangle, tile: "bg-rose-500/10 text-rose-500 ring-rose-500/25 dark:text-rose-300" },
    agent: { icon: IconPlugConnectedX, tile: "bg-rose-500/10 text-rose-500 ring-rose-500/25 dark:text-rose-300" },
};

const VISIBLE = 4;

export function NeedsAttention({ entries, now, onFocusMember }: { entries: AttentionEntry[]; now: Date; onFocusMember: (key: string) => void }) {
    return (
        <section aria-labelledby="needs-attention-title" className="emperor-panel rounded-2xl p-4">
            <header className="flex items-start gap-2.5">
                <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500 dark:text-amber-300" stroke={1.8} />
                <div className="min-w-0 flex-1">
                    <h2 id="needs-attention-title" className="text-base font-semibold text-foreground">Needs your attention</h2>
                    <p className="text-xs text-muted-foreground">Things that need your decision or input.</p>
                </div>
                {entries.length > 0 && (
                    <span className="grid h-6 min-w-6 place-items-center rounded-md bg-amber-400/15 px-1.5 text-xs font-bold tabular-nums text-amber-600 ring-1 ring-inset ring-amber-400/30 dark:text-amber-300">{entries.length}</span>
                )}
            </header>

            {entries.length === 0 ? (
                <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed border-border px-3 py-4">
                    <IconCircleCheck className="h-5 w-5 shrink-0 text-emerald-500 dark:text-emerald-300" />
                    <div className="text-sm text-muted-foreground"><span className="font-medium text-foreground">All clear.</span> Nothing is waiting on you right now.</div>
                </div>
            ) : (
                <ul className="mt-3 space-y-2">
                    {entries.slice(0, VISIBLE).map((entry) => {
                        const style = KIND_STYLE[entry.kind];
                        return (
                            <li key={entry.id} className="group relative rounded-xl border border-border/70 bg-muted/30 p-3 transition-colors hover:border-border hover:bg-muted/60 dark:bg-white/[0.02] dark:hover:bg-white/[0.04]">
                                <div className="flex gap-3">
                                    <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg ring-1 ring-inset", style.tile)}><style.icon className="h-[18px] w-[18px]" stroke={1.8} /></span>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-start gap-2">
                                            <Link href={entry.href} className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">{entry.title}</Link>
                                            <IconChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                                        </div>
                                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                            {entry.memberName && entry.memberKey ? (
                                                <button type="button" onClick={() => onFocusMember(entry.memberKey!)} className="relative z-10 font-medium hover:text-foreground">{entry.memberName}</button>
                                            ) : entry.memberName}
                                            {entry.memberName && entry.area && <span aria-hidden> · </span>}
                                            {entry.area}
                                        </div>
                                        <div className="mt-2 flex items-center justify-between gap-2">
                                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><IconClock className="h-3.5 w-3.5" />{timeAgo(entry.at, now)}</span>
                                            <Link href={entry.href} className="relative z-10 inline-flex min-h-7 items-center rounded-lg bg-cyan-500/15 px-3 text-xs font-semibold text-cyan-700 ring-1 ring-inset ring-cyan-500/40 transition hover:bg-cyan-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 dark:text-cyan-200">
                                                {entry.actionLabel}
                                            </Link>
                                        </div>
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
            {entries.length > VISIBLE && (
                <Link href="/approvals" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-cyan-700 hover:text-cyan-600 dark:text-cyan-300 dark:hover:text-cyan-200">
                    {entries.length - VISIBLE} more waiting<IconChevronRight className="h-3.5 w-3.5" />
                </Link>
            )}
        </section>
    );
}
