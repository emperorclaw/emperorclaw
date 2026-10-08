"use client";

import Link from "next/link";
import { useState } from "react";
import { IconArrowUpRight, IconUsersGroup, IconUser } from "@tabler/icons-react";
import { CharacterAvatar } from "@/components/character/character-avatar";
import { type DashboardTeam, type SceneAgent } from "@/lib/team-scene";
import { cn } from "@/lib/utils";

/** A matrix organization: repeated memberships, one stable agent identity. */
export function TeamStructure({ teams, agents, onSelect }: { teams: DashboardTeam[]; agents: SceneAgent[]; onSelect: (key: string) => void }) {
    const [focusedKey, setFocusedKey] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string[]>([]);
    const byKey = new Map(agents.map((agent) => [agent.member.key, agent]));
    const teamCounts = new Map<string, number>();
    for (const team of teams) for (const key of team.memberKeys) teamCounts.set(key, (teamCounts.get(key) ?? 0) + 1);
    const visibleTeams = teams.filter((team) => team.memberKeys.some((key) => byKey.has(key)) || !team.memberKeys.length);
    const unassigned = agents.filter((agent) => !teamCounts.has(agent.member.key));
    const memberships = focusedKey ? teams.filter((team) => team.memberKeys.includes(focusedKey)) : [];
    return <div role="region" aria-label="Team organization" className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="text-base font-semibold text-foreground">How your teams connect</h3><p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">One agent can work across teams. Select an avatar to highlight its memberships.</p></div>
            {focusedKey && <button type="button" onClick={() => setFocusedKey(null)} className="min-h-11 rounded-lg border border-border px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">Clear highlight</button>}
        </div>
        {focusedKey && <p role="status" className="text-sm text-cyan-700 dark:text-cyan-200">{byKey.get(focusedKey)?.member.name ?? "Selected agent"} participates in {memberships.length} team{memberships.length === 1 ? "" : "s"}.</p>}
        {!visibleTeams.length ? <div className="rounded-2xl border border-dashed border-border p-8 text-center"><IconUsersGroup className="mx-auto mb-3 h-7 w-7 text-muted-foreground" /><p className="text-sm text-foreground">No teams match this view.</p><Link href="/messages" className="mt-3 inline-flex min-h-11 items-center text-sm text-cyan-700 underline underline-offset-4 dark:text-cyan-200">Open Messages to create a group</Link></div> : <div className="grid items-start gap-4 sm:grid-cols-2">
            {visibleTeams.map((team) => {
                const members = team.memberKeys.map((key) => byKey.get(key)).filter((agent): agent is SceneAgent => Boolean(agent));
                const highlighted = focusedKey && team.memberKeys.includes(focusedKey);
                const open = expanded.includes(team.id);
                return <section key={team.id} className={cn("min-w-0 rounded-2xl border bg-card p-4 transition-colors", highlighted ? "border-cyan-500/60 ring-1 ring-cyan-500/20" : "border-border")}>
                    <div className="flex items-start justify-between gap-3"><h4 className="min-w-0 break-words text-base font-semibold text-foreground">{team.name}</h4><Link href={`/messages?group=${encodeURIComponent(team.id)}`} aria-label={`Open ${team.name} conversation`} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"><IconArrowUpRight className="h-5 w-5" /></Link></div>
                    <div className="mb-4 border-l-2 border-cyan-500/40 pl-3"><p className="text-xs text-muted-foreground">Coordinator</p><p className="mt-1 break-words text-sm font-medium text-foreground">{team.coordinator?.name ?? "No coordinator"}</p>{team.coordinator?.kind === "human" && <p className="mt-1 text-xs text-muted-foreground">Human</p>}</div>
                    <div className="space-y-1">{(open ? members : members.slice(0, 6)).map(({ member, status }) => {
                        const shared = teamCounts.get(member.key) ?? 0;
                        return <button key={member.key} type="button" aria-pressed={focusedKey === member.key} onClick={() => { setFocusedKey(member.key); onSelect(member.key); }} className={cn("flex min-h-12 w-full items-center gap-3 rounded-xl px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400", focusedKey === member.key ? "bg-cyan-500/10" : "hover:bg-muted")}>
                            <CharacterAvatar agentId={member.id} name={member.name} avatarUrl={member.avatarUrl} avatarAppearance={member.avatarAppearance} size={32} status={status} decorative />
                            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-foreground">{member.name}</span><span className="block text-xs text-muted-foreground">{status === "working" ? "Working" : status === "waiting" ? "Waiting" : status === "blocked" ? "Blocked" : status === "offline" ? "Offline" : "Available"}{team.coordinator?.key === member.key ? " · Coordinator" : ""}</span></span>
                            {shared > 1 && <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground" title="Participates in multiple teams">{shared} teams</span>}
                        </button>;
                    })}</div>
                    {members.length > 6 && <button type="button" aria-expanded={open} onClick={() => setExpanded(open ? expanded.filter((id) => id !== team.id) : [...expanded, team.id])} className="mt-2 min-h-11 w-full rounded-lg text-sm text-cyan-700 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 dark:text-cyan-200">{open ? "Show fewer" : `Show all ${members.length} agents`}</button>}
                    {!!team.humanCount && <p className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground"><IconUser className="h-4 w-4" />{team.humanCount} human member{team.humanCount === 1 ? "" : "s"}</p>}
                </section>;
            })}
        </div>}
        {unassigned.length > 0 && <details className="rounded-xl border border-border p-3"><summary className="min-h-11 cursor-pointer py-3 text-sm text-muted-foreground">Agents without a team ({unassigned.length})</summary><div className="mt-2 grid gap-2 sm:grid-cols-2">{unassigned.map(({ member, status }) => <button key={member.key} type="button" onClick={() => onSelect(member.key)} className="flex min-h-12 items-center gap-3 rounded-lg p-2 text-left text-sm text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"><CharacterAvatar agentId={member.id} name={member.name} avatarUrl={member.avatarUrl} avatarAppearance={member.avatarAppearance} status={status} decorative /><span className="min-w-0 truncate">{member.name}</span></button>)}</div></details>}
    </div>;
}
