"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconArrowUpRight, IconBuilding, IconCheck, IconChevronDown, IconChevronRight, IconPlus, IconSearch, IconUser, IconUsersGroup, IconX } from "@tabler/icons-react";
import { PageHeader } from "@/components/page-header";
import { CharacterAvatar } from "@/components/character/character-avatar";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { removeOrganizationBranch, validateOrganizationTree, type OrganizationNode } from "@/lib/organization-tree";
import type { loadOrganization } from "@/lib/organization";
import type { GroupSummary } from "@/lib/groups";

type Organization = Awaited<ReturnType<typeof loadOrganization>>;
type Picker = { parentId: string | null; mode: 'choose' | 'agent' | 'human' | 'team' | 'team-leader'; replaceId?: string; teamId?: string; newTeamName?: string };
const ACTION = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-3 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50";
function legacyNodes(initial: Organization): OrganizationNode[] {
    if (initial.config.nodes) return initial.config.nodes;
    if (!initial.config.leader) return [];
    const root: OrganizationNode = { id: 'company-leader', parentId: null, kind: 'person', person: initial.config.leader };
    return [root, ...initial.teams.flatMap(team => {
        const lead = team.coordinator?.kind === 'agent' ? team.coordinator.id : '';
        const node: OrganizationNode = { id:`team-${team.id}`, parentId:root.id, kind:'team', teamId:team.id, leaderAgentId:lead };
        return [node, ...team.members.filter(m => m.kind === 'agent' && m.id !== lead).map(m => ({ id:`${team.id}-${m.id}`,parentId:node.id,kind:'person' as const,person:{kind:'agent' as const,id:m.id} }))];
    })];
}
export function OrganizationEditor({ initial, canEdit }: { initial: Organization; canEdit: boolean }) {
    const router = useRouter();
    const chartRef = useRef<HTMLDivElement>(null);
    useEffect(() => { const chart = chartRef.current; if (chart && window.innerWidth >= 768) chart.scrollLeft = (chart.scrollWidth - chart.clientWidth) / 2; }, []);
    const [nodes, setNodes] = useState<OrganizationNode[]>(() => legacyNodes(initial));
    const [pendingTeams, setPendingTeams] = useState<Record<string, string>>({});
    const [extraGroups, setExtraGroups] = useState<GroupSummary[]>([]);
    const [picker, setPicker] = useState<Picker | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [teamName, setTeamName] = useState('');
    const [collapsed, setCollapsed] = useState<string[]>([]);
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const groups = useMemo(() => [...initial.groups, ...extraGroups.filter(g => !initial.groups.some(old => old.id === g.id))], [initial.groups, extraGroups]);
    const byId = new Map(nodes.map(n => [n.id,n]));
    const selectedNode = selected ? byId.get(selected) : null;
    const root = nodes.find(n => n.parentId === null);
    const openPicker = (value: Picker) => { setPicker(value); setSelected(null); setQuery(''); setTeamName(''); setError(null); };
    const update = (next: OrganizationNode[]) => { setNodes(next); setDirty(true); setSaved(false); setPicker(null); setSelected(null); };
    const newId = () => crypto.randomUUID();
    const personName = (node: OrganizationNode) => node.kind === 'person' ? (node.person.kind === 'agent' ? initial.roster : initial.people).find(p => p.id === node.person.id)?.name ?? 'Unavailable member' : pendingTeams[node.teamId] ?? groups.find(g => g.id === node.teamId)?.title ?? 'Unavailable team';
    async function call(path: string, method: string, body: unknown) {
        const response = await fetch(path, {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'Could not save changes');
        return data;
    }
    async function save() {
        setBusy(true); setError(null); setSaved(false);
        let groupsUpdated = false;
        try {
            let valid = validateOrganizationTree(nodes);
            const savedGroups = new Map(groups.map(group => [group.id, group]));
            // Resolve draft teams only on save. Keep resolved IDs immediately so a retry
            // after a later failure reuses the chat instead of creating a duplicate.
            for (const node of valid) if (node.kind === 'team' && pendingTeams[node.teamId]) {
                const data = await call('/api/groups', 'POST', {title:pendingTeams[node.teamId],agentIds:[node.leaderAgentId],coordinator:{kind:'agent',id:node.leaderAgentId}});
                savedGroups.set(data.group.id, data.group);
                const draftId = node.teamId;
                valid = valid.map(n => n.kind === 'team' && n.teamId === draftId ? {...n,teamId:data.group.id} : n);
                setNodes(valid);
                setExtraGroups(old => [...old,data.group]);
                setPendingTeams(old => {const next = {...old}; delete next[draftId]; return next;});
                groupsUpdated = true;
            }
            // Team membership and its AI coordinator use the existing chat APIs.
            for (const node of valid) if (node.kind === 'team') {
                const group = savedGroups.get(node.teamId);
                const memberIds = new Set([node.leaderAgentId]);
                const branchIds = new Set([node.id]); let size = 0;
                while (size !== branchIds.size) { size = branchIds.size; for (const child of valid) if (child.kind === 'person' && child.person.kind === 'agent' && child.parentId && branchIds.has(child.parentId)) { branchIds.add(child.id); memberIds.add(child.person.id); } }
                const additions = [...memberIds].filter(id => !group?.members.some(m => m.kind === 'agent' && m.id === id));
                if (additions.length) { await call(`/api/groups/${node.teamId}/members`, 'POST', {agentIds:additions}); groupsUpdated = true; }
                if (group?.coordinator?.kind !== 'agent' || group.coordinator.id !== node.leaderAgentId) { await call(`/api/groups/${node.teamId}`, 'PATCH', {coordinator:{kind:'agent',id:node.leaderAgentId}}); groupsUpdated = true; }
            }
            const companyLeader = valid.find(n => n.parentId === null);
            await call('/api/organization','PATCH',{leader:companyLeader?.kind === 'person' ? companyLeader.person : null,teamIds:valid.filter(n => n.kind === 'team').map(n => n.kind === 'team' ? n.teamId : ''),nodes:valid});
            setDirty(false); setSaved(true); router.refresh();
        } catch (cause) { setError((cause instanceof Error ? cause.message : 'Could not save chart') + (groupsUpdated ? '. Team chats were updated; retry to finish saving the chart.' : '')); }
        finally { setBusy(false); }
    }
    async function choosePerson(kind: 'agent' | 'human', id: string) {
        if (!picker) return;
        if (picker.mode === 'team-leader') {
            if (picker.replaceId) {
                const target = nodes.find(n => n.id === picker.replaceId);
                const duplicate = nodes.find(n => n.parentId === picker.replaceId && n.kind === 'person' && n.person.kind === 'agent' && n.person.id === id);
                const next = nodes.filter(n => n.id !== duplicate?.id).map(n => n.id === picker.replaceId && n.kind === 'team' ? {...n,leaderAgentId:id} : duplicate && n.parentId === duplicate.id ? {...n,parentId:picker.replaceId!} : n);
                if (target?.kind === 'team' && target.leaderAgentId && target.leaderAgentId !== id && !next.some(n => n.parentId === target.id && n.kind === 'person' && n.person.id === target.leaderAgentId)) next.push({id:newId(),parentId:target.id,kind:'person',person:{kind:'agent',id:target.leaderAgentId}});
                update(next);
            }
            else {
                const group = groups.find(g => g.id === picker.teamId);
                if (!group && picker.newTeamName) {
                    const teamId = newId();
                    setPendingTeams(old => ({...old,[teamId]:picker.newTeamName!}));
                    update([...nodes,{id:newId(),parentId:picker.parentId,kind:'team',teamId,leaderAgentId:id}]);
                    return;
                }
                if (!group) return;
                const node: OrganizationNode = {id:newId(),parentId:picker.parentId,kind:'team',teamId:group.id,leaderAgentId:id};
                update([...nodes,node,...group.members.filter(m => m.kind === 'agent' && m.id !== id).map(m => ({id:newId(),parentId:node.id,kind:'person' as const,person:{kind:'agent' as const,id:m.id}}))]);
            }
            return;
        }
        const person = {kind,id};
        update(picker.replaceId ? nodes.map(n => n.id === picker.replaceId && n.kind === 'person' ? {...n,person} : n) : [...nodes,{id:newId(),parentId:picker.parentId,kind:'person',person}]);
    }
    function createTeam() {
        if (!teamName.trim() || !picker) return;
        setPicker({...picker,mode:'team-leader',newTeamName:teamName.trim()}); setQuery('');
    }
    function plus(node: OrganizationNode) {
        return canEdit && <button type="button" disabled={busy} aria-label={`Add below ${personName(node)}`} onClick={() => openPicker({parentId:node.id,mode:node.kind === 'team' ? 'agent' : 'choose'})} className="relative z-10 grid h-11 w-11 place-items-center rounded-full border border-cyan-500/35 bg-background text-cyan-500 shadow-sm transition hover:border-cyan-400 hover:bg-cyan-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50"><IconPlus className="h-5 w-5" /></button>;
    }
    function branch(node: OrganizationNode, depth = 0): React.ReactNode {
        const children = nodes.filter(n => n.parentId === node.id);
        const closed = collapsed.includes(node.id);
        const group = node.kind === 'team' ? groups.find(g => g.id === node.teamId) : null;
        const member = node.kind === 'person' ? (node.person.kind === 'agent' ? initial.roster : initial.people).find(p => p.id === node.person.id) : initial.roster.find(p => p.id === node.leaderAgentId);
        const human = node.kind === 'person' && node.person.kind === 'human';
        const agentId = node.kind === 'team' ? node.leaderAgentId : node.person.kind === 'agent' ? node.person.id : null;
        const shared = agentId ? nodes.filter(n => n.kind === 'person' && n.person.kind === 'agent' && n.person.id === agentId).length + nodes.filter(n => n.kind === 'team' && n.leaderAgentId === agentId).length : 0;
        return <li key={node.id} className={cn("relative flex min-w-0 flex-col items-start md:items-center",depth > 0 && "before:absolute before:-left-4 before:top-9 before:h-px before:w-4 before:bg-border md:before:left-1/2 md:before:-top-5 md:before:h-5 md:before:w-px")} data-org-node={node.id}>
            <article className={cn("relative w-full max-w-[280px] rounded-2xl border bg-card shadow-sm md:w-[240px]",node.kind === 'team' ? 'border-cyan-500/30' : 'border-border',selected === node.id && 'ring-2 ring-cyan-400',node.kind === 'team' && !node.leaderAgentId && 'border-amber-500/60')}>
                <button type="button" aria-label={`Options for ${personName(node)}`} onClick={() => setSelected(node.id)} className="w-full rounded-2xl p-3 text-left transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                    {node.kind === 'team' && <div className="mb-3 flex items-center gap-2 border-b border-border pb-3"><IconUsersGroup className="h-4 w-4 shrink-0 text-cyan-500" /><span className="min-w-0 break-words text-sm font-semibold">{node.kind === 'team' ? pendingTeams[node.teamId] ?? group?.title ?? 'Team' : 'Team'}</span></div>}
                    <div className="flex items-center gap-3">
                        {member ? <CharacterAvatar agentId={member.id} name={member.name ?? 'Teammate'} kind={human ? 'human' : undefined} avatarUrl={'avatarUrl' in member && typeof member.avatarUrl === 'string' ? member.avatarUrl : null} avatarAppearance={'avatarAppearance' in member ? member.avatarAppearance : null} size={44} decorative /> : <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-500"><IconPlus className="h-5 w-5" /></span>}
                        <div className="min-w-0"><p className="break-words text-sm font-semibold">{member?.name ?? (node.kind === 'team' ? 'Choose an AI leader' : 'Unavailable member')}</p><p className="mt-1 break-words text-xs text-muted-foreground">{node.kind === 'team' ? 'AI team leader' : human ? ('role' in (member ?? {}) && typeof (member as {role?:unknown})?.role === 'string' ? (member as {role:string}).role || 'Human executive' : 'Human executive') : depth <= 1 ? 'AI lead' : 'AI agent'}</p></div>
                    </div>
                    {shared > 1 && <span className="mt-3 inline-block rounded-md bg-cyan-500/10 px-2 py-1 text-xs text-cyan-600 dark:text-cyan-300">Shared · {shared} roles</span>}
                </button>
                {group && <Link href={`/messages?group=${group.id}`} className="flex min-h-11 items-center justify-center gap-1 border-t border-border text-xs text-muted-foreground hover:text-foreground">Open team chat <IconArrowUpRight className="h-4 w-4" /></Link>}
                {node.kind === 'team' && pendingTeams[node.teamId] && <p className="border-t border-border px-3 py-3 text-center text-xs text-muted-foreground">Save to create this team’s group chat</p>}
                {children.length > 1 && <button type="button" aria-expanded={!closed} aria-label={`${closed ? 'Expand' : 'Collapse'} ${personName(node)}`} onClick={() => setCollapsed(closed ? collapsed.filter(id => id !== node.id) : [...collapsed,node.id])} className="flex min-h-11 w-full items-center justify-center gap-1 border-t border-border text-xs text-muted-foreground hover:text-foreground">{closed ? <IconChevronRight className="h-4 w-4" /> : <IconChevronDown className="h-4 w-4" />}{children.length} {node.kind === 'team' ? 'teammates' : 'direct reports'}</button>}
            </article>
            {canEdit && <div className="flex w-full max-w-[280px] flex-col items-center md:w-[240px]"><span aria-hidden="true" className="h-3 w-px bg-cyan-500/30" />{plus(node)}</div>}
            {children.length > 0 && !closed && <><span aria-hidden="true" className="ml-[120px] h-5 w-px bg-border md:ml-0" /><ul aria-label={`Reports to ${personName(node)}`} className={cn("org-children flex w-full flex-col gap-5 border-l border-border pl-4 md:w-auto md:flex-row md:items-start md:border-l-0 md:px-4 md:pt-5",children.length > 1 && "md:border-t")}>{children.map(child => branch(child,depth+1))}</ul></>}
        </li>;
    }
    const parent = picker?.parentId ? byId.get(picker.parentId) : null;
    const search = query.trim().toLowerCase();
    const eligiblePeople = (picker?.mode === 'human' ? initial.people : initial.roster).filter(p => `${p.name} ${'role' in p ? p.role : ''}`.toLowerCase().includes(search)).filter(p => !(parent?.kind === 'person' && parent.person.kind === (picker?.mode === 'human' ? 'human' : 'agent') && parent.person.id === p.id) && !(parent?.kind === 'team' && parent.leaderAgentId === p.id) && (picker?.mode === 'team-leader' || !nodes.some(n => n.parentId === picker?.parentId && n.kind === 'person' && n.person.id === p.id && n.id !== picker?.replaceId)));
    return <div className="mx-auto min-w-0 max-w-[1600px] space-y-4">
        <PageHeader eyebrow="Agents" title="Organization" description="Build your reporting structure directly on the chart." actions={<><Link href="/agents" className={ACTION}>Back to agents</Link>{canEdit && dirty && <button type="button" disabled={busy} onClick={() => {setNodes(legacyNodes(initial));setPendingTeams({});setDirty(false);setError(null);}} className={ACTION}>Discard changes</button>}{canEdit && dirty && <button type="button" disabled={busy} onClick={save} className={cn(ACTION,'border-cyan-400 bg-cyan-400 text-zinc-950 hover:bg-cyan-300')}><IconCheck className="h-4 w-4" />{busy ? 'Saving…' : 'Save changes'}</button>}</>} />
        {error && <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-500">{error}</p>}
        {saved && <p role="status" className="text-sm text-emerald-500">Saved. Agents will read their reporting relationships on their next turn.</p>}
        {dirty && <p role="status" className="text-xs text-muted-foreground">Unsaved changes · Save to create new team chats and add teammates. Removing a branch keeps existing chats.</p>}
        <section aria-label="Organization chart" className="overflow-hidden rounded-2xl border border-border bg-card/30">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3"><p className="flex min-w-0 items-center gap-2 text-sm font-medium"><IconBuilding className="h-4 w-4 shrink-0 text-cyan-500" /><span className="break-words">{initial.companyName}</span></p><p className="text-xs text-muted-foreground">{canEdit ? 'Use + to add an agent or team' : 'Reporting relationships'}</p></div>
            <div ref={chartRef} className="md:max-h-[75dvh] overflow-auto overscroll-contain p-5 pb-10 md:p-10" tabIndex={0} aria-label="Scrollable reporting chart">
                {root ? <ul aria-label="Company leadership" className="flex min-w-0 md:w-max md:min-w-full md:justify-center">{branch(root)}</ul> : <div className="flex min-h-64 flex-col items-center justify-center text-center"><IconBuilding className="mb-4 h-8 w-8 text-muted-foreground" /><h2 className="text-lg font-semibold">Start with your company leader</h2><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">Choose an AI lead, or a human executive with AI leaders beneath them.</p>{canEdit && <button type="button" onClick={() => openPicker({parentId:null,mode:'agent'})} className={cn(ACTION,'mt-5')}><IconPlus className="h-4 w-4" />Choose leader</button>}</div>}
            </div>
        </section>
        <Dialog open={!!picker} onOpenChange={open => { if (!open && !busy) setPicker(null); }}>
            <DialogContent className="dark flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-md [&_[data-slot=dialog-close]]:h-11 [&_[data-slot=dialog-close]]:w-11">
                <DialogTitle>{picker?.mode === 'choose' ? 'Add a direct report' : picker?.mode === 'team-leader' ? `Choose a leader for ${picker.newTeamName ?? groups.find(g => g.id === picker.teamId)?.title ?? 'this team'}` : picker?.mode === 'team' ? 'Choose a team' : picker?.mode === 'human' ? 'Choose a human executive' : picker?.parentId === null ? 'Choose the company leader' : parent?.kind === 'team' ? 'Add a teammate' : 'Choose an agent'}</DialogTitle>
                <DialogDescription>{picker?.mode === 'team-leader' ? 'Choose one AI leader to coordinate this team. The leader joins its group chat.' : picker?.mode === 'team' ? 'Every team has a shared group chat in Messages. Create a new team here, or reuse an existing chat with its members and history.' : parent?.kind === 'team' ? `This agent will join ${personName(parent)} and its group chat when you save. Its other team memberships stay the same.` : 'Choose existing people and teams. Shared agents keep their other roles.'}</DialogDescription>
                {picker?.mode === 'choose' ? <div className="space-y-2"><button type="button" onClick={() => setPicker({...picker,mode:'agent'})} className={cn(ACTION,'w-full justify-start px-4 py-4')}><IconPlus className="h-5 w-5 text-cyan-500" /><span>Choose an agent<span className="mt-1 block text-xs text-muted-foreground">An AI agent reporting to this node</span></span></button><button type="button" onClick={() => setPicker({...picker,mode:'team'})} className={cn(ACTION,'w-full justify-start px-4 py-4')}><IconUsersGroup className="h-5 w-5 text-cyan-500" /><span>Choose a team<span className="mt-1 block text-xs text-muted-foreground">Create a team with a group chat, or reuse one</span></span></button>{parent?.kind === 'person' && parent.person.kind === 'human' && <button type="button" onClick={() => setPicker({...picker,mode:'human'})} className={cn(ACTION,'w-full justify-start')}><IconUser className="h-4 w-4" />Human executive</button>}</div> : <>
                    {picker?.parentId === null && picker.mode !== 'team-leader' && <div className="flex gap-2"><button type="button" aria-pressed={picker.mode === 'agent'} onClick={() => setPicker({...picker,mode:'agent'})} className={ACTION}>AI agent</button><button type="button" aria-pressed={picker.mode === 'human'} onClick={() => setPicker({...picker,mode:'human'})} className={ACTION}>Human</button></div>}
                    <label className="flex shrink-0 items-center gap-2 rounded-xl border border-border bg-background px-3"><IconSearch className="h-4 w-4 shrink-0 text-muted-foreground" /><input aria-label={picker?.mode === 'team' ? 'Search teams' : 'Search by name or role'} autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder={picker?.mode === 'team' ? 'Search teams…' : 'Search by name or role…'} className="min-h-12 min-w-0 flex-1 bg-transparent text-base outline-none" /></label>
                    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                        {picker?.mode !== "team" && eligiblePeople.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">No matching people. Try another name or role.</p>}
                        {picker?.mode === 'team' ? groups.filter(g => !nodes.some(n => n.kind === 'team' && n.teamId === g.id) && g.title.toLowerCase().includes(search)).map(g => <button key={g.id} type="button" onClick={() => {setPicker({...picker,mode:'team-leader',teamId:g.id});setQuery('');}} className="flex min-h-14 w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"><IconUsersGroup className="h-6 w-6 shrink-0 text-cyan-500" /><span className="min-w-0"><span className="block break-words text-sm font-medium">{g.title}</span><span className="text-xs text-muted-foreground">{g.members.length} members · Existing chat</span></span></button>) : eligiblePeople.map(p => <button key={p.id} type="button" disabled={busy} onClick={() => choosePerson(picker?.mode === 'human' ? 'human' : 'agent',p.id)} className="flex min-h-16 w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50"><CharacterAvatar agentId={p.id} name={p.name ?? 'Teammate'} kind={picker?.mode === 'human' ? 'human' : undefined} avatarUrl={'avatarUrl' in p && typeof p.avatarUrl === 'string' ? p.avatarUrl : null} avatarAppearance={'avatarAppearance' in p ? p.avatarAppearance : null} size={40} decorative /><span className="min-w-0"><span className="block break-words text-sm font-medium">{p.name}</span><span className="block text-xs text-muted-foreground">{'role' in p && typeof p.role === 'string' ? p.role || 'AI agent' : picker?.mode === 'human' ? 'Human' : 'AI agent'}</span></span></button>)}
                    </div>
                    {picker?.mode === 'team' && <div className="shrink-0 border-t border-border pt-4"><label htmlFor="new-team-name" className="text-xs font-medium text-muted-foreground">Create a new team</label><p className="mt-1 text-xs text-muted-foreground">Name it, choose an AI leader, then add teammates on the chart. Saving creates its chat.</p><div className="mt-2 flex flex-wrap gap-2"><input id="new-team-name" value={teamName} onChange={event => setTeamName(event.target.value)} placeholder="Team name" maxLength={80} className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-base" /><button type="button" disabled={busy || !teamName.trim()} onClick={createTeam} className={ACTION}>Choose AI leader</button></div></div>}
                </>}
                {picker && picker.parentId !== null && !picker.replaceId && picker.mode !== 'choose' && parent?.kind !== 'team' && <button type="button" disabled={busy} onClick={() => {setPicker({...picker,mode:picker.mode === 'team-leader' ? 'team' : 'choose',teamId:undefined,newTeamName:undefined});setQuery('');}} className={cn(ACTION,'shrink-0')}>Back</button>}
                {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
            </DialogContent>
        </Dialog>
        <Dialog open={!!selectedNode} onOpenChange={open => {if (!open) setSelected(null);}}><DialogContent className="dark sm:max-w-sm"><DialogTitle>{selectedNode ? personName(selectedNode) : 'Node options'}</DialogTitle><DialogDescription>Manage this reporting relationship.</DialogDescription>{selectedNode && <div className="space-y-2">{canEdit && <><button type="button" onClick={() => openPicker({parentId:selectedNode.id,mode:selectedNode.kind === 'team' ? 'agent' : 'choose'})} className={cn(ACTION,'w-full')}><IconPlus className="h-4 w-4" />{selectedNode.kind === 'team' ? 'Add teammate' : 'Add below'}</button><button type="button" onClick={() => openPicker({parentId:selectedNode.parentId,replaceId:selectedNode.id,mode:selectedNode.kind === 'team' ? 'team-leader' : selectedNode.person.kind === 'human' ? 'human' : 'agent'})} className={cn(ACTION,'w-full')}>{selectedNode.kind === 'team' ? 'Change AI leader' : 'Change person'}</button></>}{selectedNode.kind === 'team' ? pendingTeams[selectedNode.teamId] ? <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">Save changes to create the group chat. You can add teammates first.</p> : <Link href={`/messages?group=${selectedNode.teamId}`} className={cn(ACTION,'w-full')}>Open team chat</Link> : selectedNode.person.kind === 'agent' && <Link href={`/agents?agent=${selectedNode.person.id}`} className={cn(ACTION,'w-full')}>Agent profile</Link>}{canEdit && selectedNode.parentId !== null && <button type="button" onClick={() => update(removeOrganizationBranch(nodes,selectedNode.id))} className={cn(ACTION,'w-full text-rose-500')}><IconX className="h-4 w-4" />Remove branch from chart</button>}</div>}</DialogContent></Dialog>
    </div>;
}
