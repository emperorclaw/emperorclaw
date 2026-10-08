"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { IconArrowUpRight, IconMessage, IconRefresh } from "@tabler/icons-react";
import { queuePromptPreview } from "@/lib/queue-prompt-preview";
import { requiresHumanAction, STATUS_LABEL, timeAgo, type DashboardTeam, type SceneAgent, type SceneCommunication } from "@/lib/team-scene";
import { AgentAvatar, STATUS_COLOR } from "./agent-character";

const LINK = "flex min-h-11 items-center gap-3 rounded-xl border border-border bg-white/[0.025] px-3 py-3 transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400";

/** A work briefing: evidence first, one primary action, settings on the profile. */
export function SelectedAgent({ agent, canAct, now, onMessage, teams = [], communications = [] }: {
    agent: SceneAgent | null;
    canAct: boolean;
    now: Date;
    onMessage?: () => void;
    teams?: DashboardTeam[];
    communications?: SceneCommunication[];
}) {
    const router = useRouter();
    const [restarting, setRestarting] = useState(false);
    if (!agent) return null;
    const { member, status } = agent;
    const decisions = (agent.notices ?? []).filter(requiresHumanAction);
    const observations = (agent.notices ?? []).filter((entry) => !requiresHumanAction(entry));
    const work = [...member.working, ...member.waiting, ...member.next]
        .filter((task, index, all) => all.findIndex((other) => other.id === task.id) === index);
    const memberships = teams.filter((team) => team.memberKeys.includes(member.key));
    // Only communications already authorized by the dashboard server are passed in.
    const latest = communications.filter((entry) => entry.actorKey === member.key || entry.targetKey === member.key)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    const disconnected = member.kind === "agent" && member.health === "down" && !member.activity && !member.runtimeOnline;
    const restart = async () => {
        setRestarting(true);
        try {
            const res = await fetch(`/api/agents/${member.id}/recreate-runtime`, { method: "POST" });
            const data = await res.json().catch(() => ({})) as { error?: string; success?: boolean; message?: string };
            if (!res.ok || data.success === false) throw new Error(data.error || data.message || "Couldn't restart the runtime");
            toast.success("Restarting runtime…");
            router.refresh();
        } catch (error) { toast.error(error instanceof Error ? error.message : "Something went wrong"); }
        finally { setRestarting(false); }
    };

    return (
        <section className="flex min-h-0 flex-1 flex-col">
            <header className="relative shrink-0 border-b border-border px-5 pb-5 pt-6 sm:px-6">
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-br from-cyan-500/10 via-transparent to-transparent" />
                <div className="relative flex items-center gap-4 pr-8">
                    <AgentAvatar id={member.id} kind={member.kind} name={member.name} avatarUrl={member.avatarUrl} avatarAppearance={member.avatarAppearance} status={status} size={64} />
                    <div className="min-w-0">
                        <h2 className="break-words text-xl font-semibold tracking-tight text-foreground">{member.name}</h2>
                        <p className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">{member.role || (member.kind === "human" ? "Teammate" : "Agent")}</p>
                        <p className="mt-2 flex items-center gap-2 text-xs font-medium text-foreground/80"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[status] }} />{STATUS_LABEL[status]}</p>
                    </div>
                </div>
            </header>

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-6">
                {decisions.length > 0 && <section aria-label="Your decisions" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                    <h3 className="mb-2 text-xs font-semibold text-amber-200">Needs your decision · {decisions.length}</h3>
                    <div className="space-y-2">{decisions.slice(0, 3).map((entry) => <Link key={entry.id} href={entry.href} className={LINK}><div className="min-w-0 flex-1"><p className="line-clamp-2 break-words text-sm font-medium">{entry.title}</p><p className="mt-1 text-xs text-amber-200">{entry.actionLabel || "Review"}</p></div><IconArrowUpRight className="h-4 w-4 shrink-0" /></Link>)}</div>
                    {decisions.length > 3 && <details className="mt-2"><summary className="min-h-11 cursor-pointer py-3 text-xs text-amber-200">{decisions.length - 3} more decisions</summary><div className="space-y-2">{decisions.slice(3).map((entry) => <Link key={entry.id} href={entry.href} className={LINK}><span className="min-w-0 flex-1 break-words text-sm">{entry.title}</span><IconArrowUpRight className="h-4 w-4 shrink-0" /></Link>)}</div></details>}
                </section>}

                <section aria-label="Current work">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{member.activity ? "Live activity" : "Work"}</h3>
                    {member.activity && <p className="mt-2 line-clamp-3 break-words text-sm leading-6 text-foreground">{queuePromptPreview(member.activity)}</p>}
                    {work.length > 0 ? <div className="mt-3 space-y-2">{work.slice(0, 3).map((task) => <Link key={task.id} href={`/projects?project=${task.projectId}&task=${task.id}`} className={LINK}><div className="min-w-0 flex-1"><p className="line-clamp-2 break-words text-sm font-medium">{task.title}</p><p className="mt-1 truncate text-xs text-muted-foreground">{task.state.replaceAll("_", " ")}{task.projectName && ` · ${task.projectName}`}</p></div><IconArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" /></Link>)}{work.length > 3 && <Link href={member.href} className="inline-flex min-h-11 items-center text-sm text-cyan-200">View all {work.length} tasks <IconArrowUpRight className="ml-1 h-4 w-4" /></Link>}</div> : !member.activity && <p className="mt-2 text-sm leading-6 text-muted-foreground">No tracked task in progress.{canAct && member.kind === "agent" && " Send a message to give direction or check in."}</p>}
                    {member.doneToday > 0 && <p className="mt-3 text-xs text-emerald-300">{member.doneToday} {member.doneToday === 1 ? "task" : "tasks"} completed today</p>}
                </section>

                {latest && <section aria-label="Latest exchange"><h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Latest exchange</h3><Link href={latest.href} className={LINK}><div className="min-w-0 flex-1"><p className="line-clamp-3 break-words text-sm leading-6">{queuePromptPreview(latest.text)}</p><p className="mt-1 text-xs text-muted-foreground">{latest.actorKey === member.key ? "Sent" : "Received"} · {timeAgo(latest.at, now)} · Open conversation</p></div><IconArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" /></Link></section>}

                {memberships.length > 0 && <section aria-label="Teams"><h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Teams</h3><div className="flex flex-wrap gap-2">{memberships.map((team) => <Link key={team.id} href={`/messages?group=${team.id}`} className="inline-flex min-h-11 max-w-full items-center rounded-lg border border-border px-3 text-sm transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"><span className="truncate">{team.name}{team.coordinator?.key === member.key ? " · Coordinator" : ""}</span></Link>)}</div></section>}

                {disconnected && <section className="rounded-xl border border-border p-3"><p className="text-sm font-medium">Runtime connection unavailable</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Messages can be queued until the runtime reconnects.</p>{canAct && member.canRestartRuntime && <button type="button" disabled={restarting} onClick={restart} className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:opacity-50"><IconRefresh className="h-4 w-4" />{restarting ? "Restarting…" : "Restart runtime"}</button>}</section>}
                {(observations.length > 0 || member.lastActivityAt) && <details className="border-t border-border"><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">Connection & observations</summary><div className="space-y-2 pb-1">{member.lastActivityAt && <p className="text-xs text-muted-foreground">Last seen {timeAgo(member.lastActivityAt, now)}</p>}{observations.map((entry) => <Link key={entry.id} href={entry.href} className={LINK}><span className="break-words text-sm text-muted-foreground">{entry.title}</span></Link>)}</div></details>}
            </div>

            <footer className="shrink-0 border-t border-border bg-background/90 px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
                {member.kind === "agent" && <button type="button" onClick={onMessage} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 text-sm font-semibold text-zinc-950 transition hover:bg-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-background"><IconMessage className="h-4 w-4 shrink-0" /><span className="min-w-0 break-words">{canAct ? `Talk to ${member.name}` : "Read conversation"}</span></button>}
                <Link href={member.href} className="mt-1 flex min-h-11 items-center justify-center gap-1 text-sm text-muted-foreground transition hover:text-foreground">{member.kind === "agent" ? "Agent profile & settings" : "View teammate"}<IconArrowUpRight className="h-4 w-4" /></Link>
            </footer>
        </section>
    );
}
