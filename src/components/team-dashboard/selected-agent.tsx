import Link from "next/link";
import dynamic from "next/dynamic";
import { IconArrowsMaximize, IconMessage, IconUserSquareRounded } from "@tabler/icons-react";
import { nextStepLabel, STATUS_LABEL, taskStep, ZONES, type SceneAgent } from "@/lib/team-scene";
import { cn } from "@/lib/utils";
import { AgentAvatar, STATUS_COLOR } from "./agent-character";

const AgentMiniChat = dynamic(() => import("./agent-mini-chat").then((m) => m.AgentMiniChat), {
    loading: () => <div className="mt-3 rounded-xl border border-border/80 bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground animate-pulse dark:bg-white/[0.02]">Loading chat…</div>,
});

const PILL: Record<SceneAgent["status"], string> = {
    working: "bg-emerald-500/12 text-emerald-600 ring-emerald-500/30 dark:text-emerald-300",
    waiting: "bg-amber-500/12 text-amber-600 ring-amber-500/30 dark:text-amber-300",
    blocked: "bg-amber-500/12 text-amber-600 ring-amber-500/30 dark:text-amber-300",
    idle: "bg-emerald-500/12 text-emerald-600 ring-emerald-500/30 dark:text-emerald-300",
    offline: "bg-zinc-500/12 text-zinc-500 ring-zinc-500/30 dark:text-zinc-400",
};

export function SelectedAgent({ agent }: { agent: SceneAgent | null }) {
    if (!agent) {
        return (
            <section className="emperor-panel rounded-2xl p-4">
                <h2 className="flex items-center gap-2 text-base font-semibold text-foreground"><IconUserSquareRounded className="h-5 w-5 text-muted-foreground" stroke={1.8} />Selected agent</h2>
                <p className="mt-3 text-sm text-muted-foreground">Pick someone on the floor to see what they are doing.</p>
            </section>
        );
    }
    const { member, status, behavior } = agent;
    const task = member.working[0] ?? member.waiting[0] ?? member.next[0] ?? null;
    const { step, total } = task ? taskStep(task.state) : { step: 0, total: 4 };
    const online = member.kind === "human" ? null : status === "offline" ? "Offline" : member.health === "idle" ? "Away" : "Online";
    const description = member.skills.length > 0 ? `Skills: ${member.skills.slice(0, 4).join(", ")}${member.skills.length > 4 ? "…" : ""}` : ZONES[agent.zone === "lounge" ? "operations" : agent.zone].blurb;
    const upNext = member.next.find((t) => t.id !== task?.id);

    return (
        <section aria-labelledby="selected-agent-title" className="emperor-panel rounded-2xl p-4">
            <header className="flex items-center justify-between">
                <h2 id="selected-agent-title" className="flex items-center gap-2 text-base font-semibold text-foreground"><IconUserSquareRounded className="h-5 w-5 text-muted-foreground" stroke={1.8} />Selected agent</h2>
                <Link href={member.href} aria-label={`Open ${member.name}`} className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground">
                    <IconArrowsMaximize className="h-4 w-4" />
                </Link>
            </header>

            <div className="mt-3 flex gap-3">
                <AgentAvatar id={member.id} kind={member.kind} name={member.name} avatarUrl={member.avatarUrl} avatarAppearance={member.avatarAppearance} status={status} size={56} />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[status] }} />
                        <span className="truncate text-base font-semibold text-foreground">{member.name}</span>
                        <span title={online ? "Runtime connection" : undefined} className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset", PILL[status])}>{online ?? STATUS_LABEL[status]}</span>
                    </div>
                    <div className="mt-0.5 truncate text-sm text-foreground/80">{member.role || (member.kind === "human" ? "Teammate" : "Agent")}</div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{description}</p>
                </div>
            </div>

            <div className="mt-4">
                <span className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-700 ring-1 ring-inset ring-cyan-500/30 dark:text-cyan-200">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR[status] }} />
                    {behavior.caption}
                </span>
                <div className="mt-2 flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-medium text-foreground">{task ? task.title : agent.activity}</span>
                    {task && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">Step {step} of {total}</span>}
                </div>
                <div className="mt-2 grid grid-cols-4 gap-1.5" aria-hidden>
                    {Array.from({ length: total }, (_, i) => (
                        <span key={i} className={cn("h-1.5 rounded-full", i < step ? "bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)]" : "bg-muted dark:bg-white/10")} />
                    ))}
                </div>
                <p className="mt-2 truncate text-xs text-muted-foreground">
                    {task ? <>Next: {task.state === "inbox" ? nextStepLabel(task.state) : upNext ? `${nextStepLabel(task.state)}, then “${upNext.title}”` : nextStepLabel(task.state)}</> : "No open task. Available for new work."}
                </p>
            </div>

            {member.kind === "agent" && <AgentMiniChat key={member.id} agentId={member.id} agentName={member.name} />}

            <div className="mt-3 flex items-center gap-2">
                <Link href={`/messages?agent=${member.id}`} className="inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-cyan-500/10 text-sm font-semibold text-cyan-700 ring-1 ring-inset ring-cyan-500/50 transition hover:bg-cyan-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 dark:text-cyan-200">
                    <IconMessage className="h-4 w-4" />Open in Messages
                </Link>
                <Link href={member.href} className="inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-sm font-semibold text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                    View agent
                </Link>
            </div>
        </section>
    );
}
