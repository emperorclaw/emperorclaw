"use client";

import Link from "next/link";
import { AgentGoalControls } from "@/components/agent-goal-controls";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { IconMessage, IconRefresh, IconUserSquareRounded } from "@tabler/icons-react";
import { requiresHumanAction, STATUS_LABEL, timeAgo, type SceneAgent } from "@/lib/team-scene";
import { cn } from "@/lib/utils";
import { AgentAvatar, STATUS_COLOR } from "./agent-character";

const PILL: Record<SceneAgent["status"], string> = {
    working: "bg-emerald-500/12 text-emerald-600 ring-emerald-500/30 dark:text-emerald-300",
    waiting: "bg-amber-500/12 text-amber-600 ring-amber-500/30 dark:text-amber-300",
    blocked: "bg-amber-500/12 text-amber-600 ring-amber-500/30 dark:text-amber-300",
    idle: "bg-emerald-500/12 text-emerald-600 ring-emerald-500/30 dark:text-emerald-300",
    offline: "bg-zinc-500/12 text-zinc-500 ring-zinc-500/30 dark:text-zinc-400",
};

export function SelectedAgent({ agent, canAct, now, onMessage }: { agent: SceneAgent | null; canAct: boolean; now: Date; onMessage?: () => void }) {
    const router = useRouter();
    const [restarting, setRestarting] = useState(false);
    if (!agent) {
        return (
            <section className="emperor-panel rounded-2xl p-4">
                <h2 className="flex items-center gap-2 text-base font-semibold text-foreground"><IconUserSquareRounded className="h-5 w-5 text-muted-foreground" stroke={1.8} />Agent actions</h2>
                <p className="mt-3 text-sm text-muted-foreground">Pick someone on the floor to see what they are doing.</p>
            </section>
        );
    }
    const { member, status, behavior } = agent;
    const task = member.working[0] ?? member.waiting[0] ?? member.next[0] ?? null;
    const connection = member.activity || member.runtimeOnline ? "Connected" : member.lastActivityAt ? "No recent connection" : "Connection unconfirmed";

    const restart = async () => {
        if (!member.kind || member.kind !== "agent") return;
        setRestarting(true);
        try {
            const res = await fetch(`/api/agents/${member.id}/recreate-runtime`, { method: "POST" });
            const data = await res.json().catch(() => ({})) as { error?: string; success?: boolean; message?: string };
            if (!res.ok || data.success === false) throw new Error(data.error || data.message || "Couldn't restart the runtime");
            toast.success("Restarting runtime…");
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Something went wrong");
        } finally {
            setRestarting(false);
        }
    };

    return (
        <section aria-labelledby="selected-agent-title" className="min-w-0 w-full rounded-2xl p-1">
            <header className="flex items-center justify-between">
                <h2 id="selected-agent-title" className="flex items-center gap-2 text-base font-semibold text-foreground"><IconUserSquareRounded className="h-5 w-5 text-muted-foreground" stroke={1.8} />Agent actions</h2>

            </header>

            <div className="mt-3 flex gap-3">
                <AgentAvatar id={member.id} kind={member.kind} name={member.name} avatarUrl={member.avatarUrl} avatarAppearance={member.avatarAppearance} status={status} size={56} />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[status] }} />
                        <span className="truncate text-base font-semibold text-foreground">{member.name}</span>
                        <span title="Work status" className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset", PILL[status])}>{STATUS_LABEL[status]}</span>
                    </div>
                    <div className="mt-0.5 truncate text-sm text-foreground/80">{member.role || (member.kind === "human" ? "Teammate" : "Agent")}</div>

                </div>
            </div>

            <div className="mt-4">
                <span className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-700 ring-1 ring-inset ring-cyan-500/30 dark:text-cyan-200">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR[status] }} />
                    {behavior.caption}
                </span>
                <div className="mt-2 flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 line-clamp-3 font-medium text-foreground [overflow-wrap:anywhere]">{task ? task.title : agent.activity}</span>
                </div>
                {task && <Link href={`/projects?project=${task.projectId}&task=${task.id}`} className="mt-2 inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">Open task · {task.state.replaceAll("_", " ")}</Link>}
                <p className="mt-2 text-xs text-muted-foreground">{connection}{member.lastActivityAt && ` · last seen ${timeAgo(member.lastActivityAt, now)}`}</p>
            </div>

            {(agent.notices?.length ?? 0) > 0 && <details className="mt-3 rounded-lg border border-border"><summary className="min-h-11 cursor-pointer px-3 py-3 text-sm text-muted-foreground">Actions & observations ({agent.notices?.length})</summary><ul className="space-y-2 px-2 pb-2" aria-label="Issues alongside this agent’s work">
                {agent.notices?.map((entry) => <li key={entry.id}><Link href={entry.href} className="flex min-h-11 items-start gap-2 rounded-lg border border-border bg-muted/30 p-2.5 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                    <span className="shrink-0 font-semibold text-muted-foreground">{requiresHumanAction(entry) ? "Action" : "Watch"}</span><span className="min-w-0 break-words">{entry.title}</span>
                </Link></li>)}
            </ul></details>}

            {/* Health + fix action */}
            {member.kind === "agent" && member.health === "down" && !member.activity && (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs">
                    <span className="min-w-0 truncate font-medium text-rose-600 dark:text-rose-300">No recent runtime connection</span>
                    {canAct && member.canRestartRuntime && (
                        <button type="button" disabled={restarting} onClick={restart} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md bg-rose-500/15 px-2 py-1 font-semibold text-rose-700 ring-1 ring-inset ring-rose-500/40 transition hover:bg-rose-500/25 disabled:opacity-50 dark:text-rose-200">
                            <IconRefresh className="h-3.5 w-3.5" />{restarting ? "Restarting…" : "Restart"}
                        </button>
                    )}
                </div>
            )}
            {member.kind === "agent" && member.health === "attention" && member.healthReasons.length > 0 && (
                <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    Observation: {member.healthReasons[0]}
                </div>
            )}

            {canAct && <AgentGoalControls agentId={member.id} />}
            <div className="mt-3 flex items-center gap-2">
                <button type="button" onClick={onMessage} className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-cyan-500/10 text-sm font-semibold text-cyan-700 ring-1 ring-inset ring-cyan-500/50 transition hover:bg-cyan-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 dark:text-cyan-200">
                    <IconMessage className="h-4 w-4" />{canAct ? "Send message" : "Read conversation"}
                </button>
                <Link href={member.href} className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-sm font-semibold text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                    View agent
                </Link>
            </div>
        </section>
    );
}
