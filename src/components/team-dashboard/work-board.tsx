import Link from "next/link";
import {
    IconArrowRight, IconFileText, IconBug, IconChartBar, IconCheck, IconChevronRight, IconCode, IconCoffee, IconListDetails, IconPencil, IconPlus, IconSend, IconSettings,
} from "@tabler/icons-react";
import { describeActivity, taskStep, timeAgo, type ActivityEvent, type DashboardMember, type DashboardTask, type ZoneId } from "@/lib/team-scene";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./agent-character";

export const ZONE_ICON: Record<ZoneId, typeof IconCode> = {
    research: IconChartBar,
    content: IconPencil,
    engineering: IconCode,
    qa: IconBug,
    operations: IconSettings,
    lounge: IconCoffee,
};

const COLUMNS = [
    { id: "inProgress", label: "In progress", dot: "bg-sky-400" },
    { id: "review", label: "In review", dot: "bg-violet-400" },
    { id: "done", label: "Done in 24h", dot: "bg-emerald-400" },
] as const;

const ROWS_PER_COLUMN = 4;

export interface BoardAssignee { member: DashboardMember; zone: ZoneId }

export function WorkBoard({ columns, assignees, activity, now }: {
    columns: Record<(typeof COLUMNS)[number]["id"], DashboardTask[]>;
    assignees: Map<string, BoardAssignee>;
    activity: ActivityEvent[];
    now: Date;
}) {
    const latest = activity[0] ?? null;
    return (
        <section aria-labelledby="work-in-motion-title" className="emperor-panel rounded-2xl p-4">
            <header className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                    <IconListDetails className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" stroke={1.8} />
                    <div>
                        <h2 id="work-in-motion-title" className="text-base font-semibold text-foreground">Work in motion</h2>
                        <p className="text-xs text-muted-foreground">Tasks across your team, grouped by current status.</p>
                    </div>
                </div>
                <Link href="/projects" className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                    <IconPlus className="h-4 w-4" />New task
                </Link>
            </header>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
                {COLUMNS.map((col) => {
                    const tasks = columns[col.id];
                    return (
                        <div key={col.id} className="min-w-0 rounded-xl border border-border/70 bg-muted/30 p-2 dark:bg-white/[0.015]">
                            <h3 className="flex items-center gap-2 px-1.5 py-1 text-sm font-semibold text-foreground">
                                <span className={cn("h-2 w-2 rounded-full", col.dot)} />{col.label}
                                <span className="rounded-md bg-muted px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground dark:bg-white/[0.06]">{tasks.length}</span>
                            </h3>
                            {tasks.length === 0 ? (
                                <p className="px-2 py-4 text-xs text-muted-foreground">Nothing here right now.</p>
                            ) : (
                                <ul className="mt-1 space-y-1.5">
                                    {tasks.slice(0, ROWS_PER_COLUMN).map((task) => <TaskRow key={task.id} task={task} assignee={task.assigneeKey ? assignees.get(task.assigneeKey) ?? null : null} />)}
                                </ul>
                            )}
                            {tasks.length > ROWS_PER_COLUMN && (
                                <Link href="/projects" className="mt-1.5 flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                                    {tasks.length - ROWS_PER_COLUMN} more<IconChevronRight className="h-3.5 w-3.5" />
                                </Link>
                            )}
                        </div>
                    );
                })}
            </div>

            <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3 text-xs">
                {latest ? <TickerLine event={latest} now={now} /> : <span className="text-muted-foreground">No task activity in the last 24 hours.</span>}
                <Link href="/projects" className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground">View all activity<IconArrowRight className="h-3.5 w-3.5" /></Link>
            </footer>
        </section>
    );
}

function TaskRow({ task, assignee }: { task: DashboardTask; assignee: BoardAssignee | null }) {
    const Icon = assignee ? ZONE_ICON[assignee.zone] : IconFileText;
    return (
        <li>
            <Link href={`/projects?project=${task.projectId}&task=${task.id}`}
                className="group flex items-center gap-2.5 rounded-lg border border-transparent bg-background/60 px-2.5 py-2 transition hover:border-border hover:bg-background dark:bg-white/[0.025] dark:hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground dark:bg-white/[0.05]"><Icon className="h-4 w-4" stroke={1.8} /></span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{task.title}</span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        {assignee ? (
                            <>
                                <AgentAvatar id={assignee.member.id} kind={assignee.member.kind} name={assignee.member.name} avatarUrl={assignee.member.avatarUrl} avatarAppearance={assignee.member.avatarAppearance} size={16} />
                                <span className="truncate">{assignee.member.name}</span>
                            </>
                        ) : <span>Unassigned</span>}
                        {task.projectName && <span className="max-w-[8rem] shrink-0 truncate rounded-md bg-cyan-500/10 px-1.5 py-px text-[10px] font-medium text-cyan-700 ring-1 ring-inset ring-cyan-500/20 dark:text-cyan-200">{task.projectName}</span>}
                    </span>
                </span>
                <StepMark state={task.state} />
                <IconChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
        </li>
    );
}

function StepMark({ state }: { state: string }) {
    const { step, total } = taskStep(state);
    if (step >= total) {
        return <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-500 text-white shadow-[0_0_10px_rgba(16,185,129,0.5)]" aria-label="Done"><IconCheck className="h-3.5 w-3.5" stroke={3} /></span>;
    }
    const r = 7;
    const c = 2 * Math.PI * r;
    return (
        <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground" aria-label={`Step ${step} of ${total}`}>
            <svg viewBox="0 0 18 18" className="h-[18px] w-[18px] -rotate-90">
                <circle cx={9} cy={9} r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={2} />
                <circle cx={9} cy={9} r={r} fill="none" stroke={state === "review" ? "#a78bfa" : "#38bdf8"} strokeWidth={2} strokeDasharray={`${(c * step) / total} ${c}`} strokeLinecap="round" />
            </svg>
            {step}/{total}
        </span>
    );
}

function TickerLine({ event, now }: { event: ActivityEvent; now: Date }) {
    const { actor, verb, target } = describeActivity(event);
    return (
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <IconSend className="h-4 w-4 shrink-0 text-cyan-500 dark:text-cyan-300" stroke={1.8} />
            <span className="min-w-0 truncate">
                <span className="font-semibold text-cyan-700 dark:text-cyan-300">{actor}</span> {verb}{target && <> <span className="font-semibold text-cyan-700 dark:text-cyan-300">{target}</span></>}
                <span aria-hidden> · </span>{timeAgo(event.at, now)}
            </span>
        </span>
    );
}
