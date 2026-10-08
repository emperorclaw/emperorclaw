"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconArrowUpRight, IconUsersGroup, IconUser, IconBuilding, IconHierarchy2 } from "@tabler/icons-react";
import { GroupDialog, type GroupDialogGroup } from "@/components/group-dialog";
import { useSession } from "next-auth/react";
import { CharacterAvatar } from "@/components/character/character-avatar";
import { type DashboardTeam, type DashboardMember, type SceneAgent } from "@/lib/team-scene";
import { cn } from "@/lib/utils";

/** A matrix organization: repeated memberships, one stable agent identity. */
export function TeamStructure({ teams, agents, onSelect, canEdit = false, people = [], companyName = "Your company", onTeamCreated, leader, showWorkStatus = true }: { showWorkStatus?: boolean; onTeamCreated?: (id: string) => Promise<void>; leader?: {name: string; kind: "agent" | "human"; id: string; avatarUrl?: string | null; avatarAppearance?: unknown} | null; companyName?: string; people?: DashboardMember[]; canEdit?: boolean; teams: DashboardTeam[]; agents: SceneAgent[]; onSelect: (key: string) => void }) {
    const router = useRouter();
    const { data: session } = useSession();
    const [groupEditor, setGroupEditor] = useState<GroupDialogGroup | null | undefined>(undefined);
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [rosterQuery, setRosterQuery] = useState("");
    const [assignment, setAssignment] = useState("");
    const [dropTeam, setDropTeam] = useState<string | null>(null);
    async function setCoordinator(teamId: string, key: string) {
        if (!canEdit || busy) return;
        setBusy(true); setError(null);
        try {
            const coordinator = key ? { kind: key.startsWith("human:") ? "human" : "agent", id: key.slice(6) } : null;
            const response = await fetch(`/api/groups/${encodeURIComponent(teamId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ coordinator }) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Could not update coordinator");
            router.refresh();
        } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update coordinator"); }
        finally { setBusy(false); }
    }
    async function addMember(teamId: string, key: string) {
        if (!canEdit || busy || !agents.some(a => a.member.key === key)) return;
        if (teams.find(t => t.id === teamId)?.memberKeys.includes(key)) return;
        setBusy(true); setError(null);
        try {
            const response = await fetch(`/api/groups/${encodeURIComponent(teamId)}/members`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentIds: [key.slice(6)] }) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Could not update team");
            router.refresh();
        } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update team"); }
        finally { setBusy(false); setDropTeam(null); }
    }
    const [focusedKey, setFocusedKey] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string[]>([]);
    const byKey = new Map(agents.map((agent) => [agent.member.key, agent]));
    const teamCounts = new Map<string, number>();
    for (const team of teams) for (const key of team.memberKeys) teamCounts.set(key, (teamCounts.get(key) ?? 0) + 1);
    const visibleTeams = teams;
    const unassigned = agents.filter((agent) => !teamCounts.has(agent.member.key));
    const memberships = focusedKey ? teams.filter((team) => team.memberKeys.includes(focusedKey)) : [];
    return <div role="region" aria-label="Team organization" className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="text-base font-semibold text-foreground">Organization</h3><p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">Your teams and the people who coordinate them. Shared agents keep the same identity across teams.</p></div>
            {canEdit && <button type="button" onClick={() => setGroupEditor(null)} className="min-h-11 rounded-lg border border-border px-3 text-sm hover:bg-muted">Add team</button>}
            {canEdit && <button type="button" aria-pressed={editing} onClick={() => setEditing(!editing)} className="min-h-11 rounded-lg border border-border px-3 text-sm hover:bg-muted">{editing ? "Done editing" : "Arrange teams"}</button>}
            {focusedKey && <button type="button" onClick={() => setFocusedKey(null)} className="min-h-11 rounded-lg border border-border px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">Clear highlight</button>}
        </div>
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        {editing && <div className="rounded-2xl border border-cyan-500/30 bg-cyan-500/5 p-4">
            <p className="mb-3 text-sm text-muted-foreground">Drag an agent onto a team, or select an agent and use Add here. Existing memberships stay intact.</p>
            <label className="mb-3 block text-xs text-muted-foreground">Find an agent<input type="search" value={rosterQuery} onChange={event => setRosterQuery(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-border bg-background px-3 text-base" placeholder="Search by name or role" /></label><div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto p-1">{agents.filter(({member}) => `${member.name} ${member.role ?? ""}`.toLowerCase().includes(rosterQuery.toLowerCase())).map(({member}) => <button key={member.key} type="button" draggable={!busy} disabled={busy} aria-pressed={assignment === member.key} onClick={() => setAssignment(member.key)} onDragStart={event => { event.dataTransfer.setData("application/x-emperor-agent", member.key); event.dataTransfer.effectAllowed = "copy"; setAssignment(member.key); }} className={cn("flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-sm", assignment === member.key ? "border-cyan-500 bg-cyan-500/10" : "border-border bg-card", "disabled:opacity-50")}><CharacterAvatar agentId={member.id} name={member.name} avatarUrl={member.avatarUrl} avatarAppearance={member.avatarAppearance} size={24} decorative />{member.name}</button>)}</div>
        </div>}
        {focusedKey && <p role="status" className="text-sm text-cyan-700 dark:text-cyan-200">{byKey.get(focusedKey)?.member.name ?? "Selected agent"} participates in {memberships.length} team{memberships.length === 1 ? "" : "s"}.</p>}
        {visibleTeams.length > 0 && <div className="flex flex-col items-center pt-2" aria-label="Company organization root"><div className="flex max-w-full items-center gap-3 rounded-2xl border border-cyan-500/30 bg-cyan-500/5 px-5 py-4"><IconBuilding className="h-6 w-6 shrink-0 text-cyan-500" /><div className="min-w-0"><p className="break-words font-semibold text-foreground">{companyName}</p><p className="mt-1 text-xs text-muted-foreground">{teams.length} work teams · Coordinators are optional</p></div></div>{leader && <><div aria-hidden="true" className="h-4 w-px bg-cyan-500/30" /><div className="flex max-w-full items-center gap-3 rounded-xl border border-cyan-500/40 bg-card px-4 py-3"><CharacterAvatar agentId={leader.id} kind={leader.kind === "human" ? "human" : undefined} name={leader.name} avatarUrl={leader.avatarUrl} avatarAppearance={leader.avatarAppearance} size={40} decorative /><div className="min-w-0"><p className="text-xs text-muted-foreground">Company leader</p><p className="break-words text-sm font-semibold text-foreground">{leader.name}</p></div></div></>}<div aria-hidden="true" className="h-6 w-px bg-cyan-500/30" /><div className="flex items-center gap-2 text-xs text-muted-foreground"><IconHierarchy2 className="h-4 w-4" />Team membership · agents can be shared</div><div aria-hidden="true" className="h-4 w-px bg-cyan-500/30" /></div>}
        {!visibleTeams.length ? <div className="rounded-2xl border border-dashed border-border p-8 text-center"><IconUsersGroup className="mx-auto mb-3 h-7 w-7 text-muted-foreground" /><p className="text-sm text-foreground">No teams match this view.</p><Link href="/messages" className="mt-3 inline-flex min-h-11 items-center text-sm text-cyan-700 underline underline-offset-4 dark:text-cyan-200">Open Messages to create a group</Link></div> : <div className="grid items-start gap-4 border-t border-cyan-500/20 pt-6 sm:grid-cols-2">
            {visibleTeams.map((team) => {
                const members = team.memberKeys.map((key) => byKey.get(key)).filter((agent): agent is SceneAgent => Boolean(agent));
                const highlighted = focusedKey && team.memberKeys.includes(focusedKey);
                const open = expanded.includes(team.id);
                const humans = team.members?.filter(member => member.kind === "human") ?? [];
                const coordinatorAgent = team.coordinator ? byKey.get(team.coordinator.key) : undefined;
                return <section key={team.id} onDragOver={event => { if (editing && !busy && event.dataTransfer.types.includes("application/x-emperor-agent")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropTeam(team.id); } }} onDragLeave={() => setDropTeam(null)} onDrop={event => { event.preventDefault(); const key = event.dataTransfer.getData("application/x-emperor-agent"); if (editing) void addMember(team.id, key); }} className={cn("relative min-w-0 rounded-2xl border bg-card p-4 transition-colors before:absolute before:-top-6 before:left-1/2 before:h-6 before:w-px before:bg-cyan-500/20", (highlighted || dropTeam === team.id) ? "border-cyan-500/60 ring-1 ring-cyan-500/20" : "border-border")}>
                    <div className="flex items-start justify-between gap-3"><h4 className="min-w-0 break-words text-base font-semibold text-foreground">{team.name}</h4><Link href={`/messages?group=${encodeURIComponent(team.id)}`} aria-label={`Open ${team.name} conversation`} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"><IconArrowUpRight className="h-5 w-5" /></Link></div>
                    {editing && team.members && <button type="button" className="mb-2 min-h-11 w-full rounded-lg border border-border text-sm hover:bg-muted" onClick={() => setGroupEditor({id:team.id,title:team.name,description:team.description ?? null,icon:team.icon,members:team.members!})}>Edit members & purpose</button>}
                    {editing && <button type="button" disabled={busy || !assignment || team.memberKeys.includes(assignment)} onClick={() => void addMember(team.id, assignment)} className="mb-3 min-h-11 w-full rounded-lg border border-dashed border-cyan-500/40 text-sm text-cyan-700 disabled:opacity-40 dark:text-cyan-200">{busy ? "Saving…" : assignment && team.memberKeys.includes(assignment) ? "Already in this team" : "Add here"}</button>}
                    <div className="mb-4 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3"><p className="text-xs text-muted-foreground">{team.coordinator || editing ? "Coordinator" : leader ? "Reports to company leader" : "Coordination"}</p>{editing ? <select aria-label={`Coordinator for ${team.name}`} disabled={busy} value={team.coordinator?.key ?? ""} onChange={event => void setCoordinator(team.id, event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-border bg-background px-2 text-sm"><option value="">No coordinator</option>{team.coordinator?.kind === "human" && <option value={team.coordinator.key}>{team.coordinator.name} · Human</option>}{members.map(({member}) => <option key={member.key} value={member.key}>{member.name}</option>)}</select> : <div className="mt-2 flex items-center gap-2">{team.coordinator && <CharacterAvatar agentId={team.coordinator.key.slice(6)} kind={team.coordinator.kind === "human" ? "human" : undefined} name={team.coordinator.name} avatarUrl={coordinatorAgent?.member.avatarUrl} avatarAppearance={coordinatorAgent?.member.avatarAppearance} size={32} decorative />}<p className="min-w-0 break-words text-sm font-medium text-foreground">{team.coordinator?.name ?? leader?.name ?? "Self-organizing team"}</p></div>}{team.coordinator?.kind === "human" && <p className="mt-1 text-xs text-muted-foreground">Human</p>}</div>
                    <div aria-hidden="true" className="mx-auto -mt-4 mb-2 h-4 w-px bg-cyan-500/30" /><div className="space-y-1">{(open ? members : members.slice(0, 6)).map(({ member, status }) => {
                        const shared = teamCounts.get(member.key) ?? 0;
                        return <button key={member.key} type="button" aria-pressed={focusedKey === member.key} onClick={() => { setFocusedKey(member.key); onSelect(member.key); }} className={cn("flex min-h-12 w-full items-center gap-3 rounded-xl px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400", focusedKey === member.key ? "bg-cyan-500/10" : "hover:bg-muted")}>
                            <CharacterAvatar agentId={member.id} name={member.name} avatarUrl={member.avatarUrl} avatarAppearance={member.avatarAppearance} size={32} status={status} decorative />
                            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-foreground">{member.name}</span><span className="block text-xs text-muted-foreground">{showWorkStatus ? (status === "working" ? "Working" : status === "waiting" ? "Waiting" : status === "blocked" ? "Blocked" : status === "offline" ? "Offline" : "Available") : member.role || "Agent"}{team.coordinator?.key === member.key ? " · Coordinator" : ""}</span></span>
                            {shared > 1 && <span className="shrink-0 rounded-md bg-cyan-500/10 px-2 py-1 text-xs text-cyan-700 dark:text-cyan-200" title="Same agent, shared across teams">Shared · {shared}</span>}
                        </button>;
                    })}</div>
                    {members.length > 6 && <button type="button" aria-expanded={open} onClick={() => setExpanded(open ? expanded.filter((id) => id !== team.id) : [...expanded, team.id])} className="mt-2 min-h-11 w-full rounded-lg text-sm text-cyan-700 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 dark:text-cyan-200">{open ? "Show fewer" : `Show all ${members.length} agents`}</button>}
                    {humans.length > 0 && <div className="mt-3 space-y-1 border-t border-border pt-3">{humans.map(human => <div key={human.id} className="flex min-h-12 items-center gap-3 px-2 py-2"><CharacterAvatar agentId={human.id} name={human.name} kind="human" size={32} decorative /><div className="min-w-0"><p className="truncate text-sm text-foreground">{human.name}</p><p className="text-xs text-muted-foreground">Human{team.coordinator?.key === `human:${human.id}` ? " · Coordinator" : ""}</p></div></div>)}</div>}
                    {!humans.length && !!team.humanCount && <p className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground"><IconUser className="h-4 w-4" />{team.humanCount} human member{team.humanCount === 1 ? "" : "s"}</p>}
                </section>;
            })}
        </div>}
        {unassigned.length > 0 && <details className="rounded-xl border border-border p-3"><summary className="min-h-11 cursor-pointer py-3 text-sm text-muted-foreground">Agents without a team ({unassigned.length})</summary><div className="mt-2 grid gap-2 sm:grid-cols-2">{unassigned.map(({ member, status }) => <button key={member.key} type="button" onClick={() => onSelect(member.key)} className="flex min-h-12 items-center gap-3 rounded-lg p-2 text-left text-sm text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"><CharacterAvatar agentId={member.id} name={member.name} avatarUrl={member.avatarUrl} avatarAppearance={member.avatarAppearance} status={status} decorative /><span className="min-w-0 truncate">{member.name}</span></button>)}</div></details>}
        {groupEditor !== undefined && <GroupDialog group={groupEditor ?? undefined} agents={agents.map(({member,status}) => ({id:member.id,name:member.name,role:member.role,avatarUrl:member.avatarUrl,status}))} humans={people.filter(m => m.kind === "human").map(m => ({id:m.id,name:m.name}))} currentUserId={(session?.user as {id?: string} | undefined)?.id ?? ""} open onOpenChange={open => { if (!open) setGroupEditor(undefined); }} onArchived={() => { setGroupEditor(undefined); router.refresh(); }} onSaved={async (id) => { const created = groupEditor === null; setGroupEditor(undefined); if (created && onTeamCreated) { try { await onTeamCreated(id); } catch (cause) { setError(cause instanceof Error ? cause.message : "Team chat created. Add it to the organization using Existing group."); } } router.refresh(); }} />}
    </div>;
}
