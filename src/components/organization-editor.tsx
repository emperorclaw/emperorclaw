"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { TeamStructure } from "@/components/team-dashboard/team-structure";
import type { loadOrganization, OrganizationConfig } from "@/lib/organization";
import type { DashboardMember, SceneAgent } from "@/lib/team-scene";

type Organization = Awaited<ReturnType<typeof loadOrganization>>;
export function OrganizationEditor({ initial, canEdit }: { initial: Organization; canEdit: boolean }) {
    const router = useRouter();
    const [config, setConfig] = useState(initial.config);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [existing, setExisting] = useState("");
    async function save(next: OrganizationConfig) {
        setBusy(true); setError(null); setSaved(false);
        try {
            const response = await fetch("/api/organization", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
            const result = await response.json();
            if (!response.ok) throw Error(result.error || "Could not save organization");
            setConfig(result.config); setSaved(true); router.refresh();
        } catch (cause) { const message = cause instanceof Error ? cause.message : "Could not save organization"; setError(message); throw Error(message); }
        finally { setBusy(false); }
    }
    const scene: SceneAgent[] = initial.roster.map(agent => {
        const online = agent.status === "online";
        const member: DashboardMember = { key: `agent:${agent.id}`, kind: "agent", id: agent.id, name: agent.name, role: agent.role, avatarUrl: agent.avatarUrl, avatarAppearance: agent.avatarAppearance, skills: [], health: null, healthReasons: [], activity: null, href: `/agents?agent=${agent.id}`, createdAt: null, doneToday: 0, working: [], waiting: [], next: [], spendTodayCents: 0, monthlyCostCents: 0, monthlyBudgetCents: 0, lastActivityAt: null, runtimeOnline: online };
        return { member, status: online ? "idle" : "offline", activity: "", zone: "operations", behavior: { kind: "available", caption: "", variant: 0 }, isNew: false };
    });
    const teams = initial.groups.filter(group => config.teamIds.includes(group.id)).map(group => ({ id: group.id, name: group.title, description: group.description, icon: group.icon, members: group.members, memberKeys: group.members.filter(member => member.kind === "agent").map(member => `agent:${member.id}`), coordinator: group.coordinator ? { key: `${group.coordinator.kind}:${group.coordinator.id}`, name: group.coordinator.name, kind: group.coordinator.kind } : null, humanCount: group.members.filter(member => member.kind === "human").length }));
    const leader = config.leader ? (config.leader.kind === "agent" ? initial.roster : initial.people).find(person => person.id === config.leader!.id) : null;
    const leaderRef = leader && config.leader ? { ...leader, ...config.leader, name: leader.name || "Teammate" } : null;
    const choices = initial.groups.filter(group => !config.teamIds.includes(group.id));
    return <div className="mx-auto max-w-6xl space-y-6">
        <PageHeader eyebrow="Agents" title="Organization" description="One company leader. Flexible teams. One shared chat per team." actions={<Link href="/agents" className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm hover:bg-muted">Back to agents</Link>} />
        <section className="rounded-2xl border border-border bg-card p-5">
            <label className="block text-sm font-semibold" htmlFor="company-leader">Company leader</label><p className="mt-1 text-sm text-muted-foreground">Coordinates across teams. This role does not change permissions.</p>
            {canEdit ? <select id="company-leader" disabled={busy} value={config.leader ? `${config.leader.kind}:${config.leader.id}` : ""} onChange={event => { const value = event.target.value; void save({ ...config, leader: value ? { kind: value.startsWith("agent:") ? "agent" : "human", id: value.slice(6) } : null }).catch(() => {}); }} className="mt-3 min-h-12 w-full rounded-xl border border-border bg-background px-3 text-base sm:max-w-md"><option value="">Choose a leader / unassigned</option><optgroup label="Agents">{initial.roster.map(agent => <option key={agent.id} value={`agent:${agent.id}`}>{agent.name}</option>)}</optgroup><optgroup label="People">{initial.people.map(person => <option key={person.id} value={`human:${person.id}`}>{person.name}</option>)}</optgroup></select> : <p className="mt-3 font-medium">{leaderRef?.name ?? "Leader not assigned"}</p>}
            <p className="mt-3 text-xs leading-5 text-muted-foreground">Agents receive their reporting relationship on their next turn and can consult the current structure. Updating it does not send messages or start work.</p>
        </section>
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}{saved && <p role="status" className="text-sm text-emerald-500">Organization saved. Agents will read it on their next turn.</p>}
        {canEdit && choices.length > 0 && <section className="flex flex-wrap items-end gap-2 rounded-xl border border-border p-4"><label className="min-w-0 flex-1 text-sm" htmlFor="existing-group">Use an existing group<select id="existing-group" value={existing} disabled={busy} onChange={event => setExisting(event.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-border bg-background px-3 text-base"><option value="">Choose a group</option>{choices.map(group => <option key={group.id} value={group.id}>{group.title}</option>)}</select></label><button type="button" disabled={!existing || busy} onClick={() => void save({ ...config, teamIds: [...config.teamIds, existing] }).then(() => setExisting("")).catch(() => {})} className="min-h-11 rounded-lg border border-border px-4 text-sm hover:bg-muted disabled:opacity-50">Add as team</button></section>}
        <div className="rounded-2xl border border-border bg-card"><TeamStructure showWorkStatus={false} companyName={initial.companyName} leader={leaderRef} teams={teams} agents={scene} canEdit={canEdit && !busy} onSelect={key => router.push(`/agents?agent=${key.slice(6)}`)} onTeamCreated={id => save({ ...config, teamIds: [...config.teamIds, id] })} people={initial.people.map(person => ({ ...(scene[0]?.member ?? {skills: [], health: null, healthReasons: [], activity: null, createdAt: null, doneToday: 0, working: [], waiting: [], next: [], spendTodayCents: 0, monthlyCostCents: 0, monthlyBudgetCents: 0, lastActivityAt: null}), id: person.id, key: `human:${person.id}`, name: person.name, kind: "human", role: "Teammate", avatarUrl: null, avatarAppearance: null, href: "/members" }))} /></div>
        {canEdit && teams.length > 0 && <details className="rounded-xl border border-border px-4"><summary className="min-h-11 cursor-pointer py-3 text-sm text-muted-foreground">Remove a team from the chart</summary><p className="mb-3 text-xs text-muted-foreground">Its chat and memberships remain available in Messages.</p><div className="space-y-2 pb-4">{teams.map(team => <div key={team.id} className="flex items-center justify-between gap-3"><span className="min-w-0 truncate text-sm">{team.name}</span><button type="button" disabled={busy} onClick={() => void save({ ...config, teamIds: config.teamIds.filter(id => id !== team.id) }).catch(() => {})} className="min-h-11 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:opacity-50">Remove</button></div>)}</div></details>}
    </div>;
}
