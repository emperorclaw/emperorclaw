import Link from "next/link";
import { IconArrowRight, IconActivity, IconArrowRightBar, IconCheck, IconMessageCircle, IconNotebook, IconShare2 } from "@tabler/icons-react";
import { timeAgo, type FeedEvent } from "@/lib/team-scene";
import { cn } from "@/lib/utils";

const KIND_STYLE: Record<FeedEvent["kind"], { icon: typeof IconShare2; tone: string }> = {
    handoff: { icon: IconShare2, tone: "text-sky-500 dark:text-sky-300" },
    review: { icon: IconArrowRightBar, tone: "text-violet-500 dark:text-violet-300" },
    done: { icon: IconCheck, tone: "text-emerald-500 dark:text-emerald-300" },
    claim: { icon: IconActivity, tone: "text-cyan-500 dark:text-cyan-300" },
    note: { icon: IconNotebook, tone: "text-amber-500 dark:text-amber-300" },
    pair: { icon: IconMessageCircle, tone: "text-cyan-500 dark:text-cyan-300" },
};

const MAX = 8;

export function MovementFeed({ feed, now, isOwnerOrAdmin }: { feed: FeedEvent[]; now: Date; isOwnerOrAdmin: boolean }) {
    return (
        <section aria-labelledby="movement-feed-title" className="emperor-panel rounded-2xl p-4">
            <header className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                    <IconActivity className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" stroke={1.8} />
                    <div>
                        <h2 id="movement-feed-title" className="text-base font-semibold text-foreground">What’s moving</h2>
                        <p className="text-xs text-muted-foreground">Handoffs, reviews and conversations across your team.</p>
                    </div>
                </div>
                <Link href="/projects" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">All activity<IconArrowRight className="h-3.5 w-3.5" /></Link>
            </header>

            {feed.length === 0 ? (
                <p className="mt-3 rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">Nothing has moved yet today.</p>
            ) : (
                <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
                    {feed.slice(0, MAX).map((e) => {
                        const style = KIND_STYLE[e.kind];
                        const pairLocked = e.kind === "pair" && !isOwnerOrAdmin;
                        const inner = (
                            <>
                                <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted/60 dark:bg-white/[0.05]", style.tone)}>
                                    <style.icon className="h-3.5 w-3.5" stroke={1.8} />
                                </span>
                                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                    {e.actorName && <span className="font-semibold text-foreground">{e.actorName}</span>}
                                    {e.targetName && <><span aria-hidden> → </span><span className="font-semibold text-foreground">{e.targetName}</span></>}
                                    <span aria-hidden> · </span>
                                    <span className="text-foreground/80">{e.text}</span>
                                </span>
                                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{timeAgo(e.at, now)}</span>
                            </>
                        );
                        const cls = "flex items-center gap-2 rounded-lg border border-transparent bg-background/60 px-2.5 py-2 transition hover:border-border hover:bg-background dark:bg-white/[0.02] dark:hover:bg-white/[0.05]";
                        if (e.href && !pairLocked) {
                            return (
                                <li key={e.id}>
                                    <Link href={e.href} className={cls}>{inner}</Link>
                                </li>
                            );
                        }
                        return (
                            <li key={e.id} className={cn(cls, pairLocked && "opacity-70")} title={pairLocked ? "Only owners and admins can open agent pair threads" : undefined}>
                                {inner}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
