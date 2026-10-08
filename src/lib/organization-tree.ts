import type { CoordinatorRef } from './team-coordination';
export type OrganizationNode = { id: string; parentId: string | null } & (
    { kind: 'person'; person: CoordinatorRef } | { kind: 'team'; teamId: string; leaderAgentId: string }
);
/** Validate before consulting records: bounded, acyclic and no ambiguous parent. */
export function validateOrganizationTree(value: unknown): OrganizationNode[] {
    if (!Array.isArray(value) || value.length > 200) throw Error('Organization supports up to 200 nodes');
    const nodes = value as OrganizationNode[];
    for (const n of nodes) {
        if (!n || typeof n.id !== 'string' || !n.id || n.id.length > 100 || (n.parentId !== null && typeof n.parentId !== 'string')) throw Error('Invalid organization node');
        if (n.kind === 'person') {
            if (!n.person || !['agent','human'].includes(n.person.kind) || typeof n.person.id !== 'string' || !n.person.id) throw Error('Choose a person for this node');
        } else if (n.kind === 'team') {
            if (typeof n.teamId !== 'string' || !n.teamId || typeof n.leaderAgentId !== 'string' || !n.leaderAgentId) throw Error('Every team needs an AI leader');
        } else throw Error('Invalid node type');
    }
    const byId = new Map(nodes.map(n => [n.id,n]));
    if (byId.size !== nodes.length) throw Error('Duplicate organization node');
    const roots = nodes.filter(n => n.parentId === null);
    if (nodes.length && (roots.length !== 1 || roots[0].kind !== 'person')) throw Error('Choose one company leader');
    const seenTeams = new Set<string>();
    for (const n of nodes) {
        if (n.kind === 'team') { if (seenTeams.has(n.teamId)) throw Error('This team is already on the chart'); seenTeams.add(n.teamId); }
        const visited = new Set([n.id]); let parentId = n.parentId;
        const ownAgent = n.kind === "team" ? n.leaderAgentId : n.person.kind === "agent" ? n.person.id : null;
        let differentAgent = false;
        while (parentId !== null) {
            const parent = byId.get(parentId);
            if (!parent) throw Error('Parent node not found');
            if (visited.has(parentId)) throw Error('Reporting relationships cannot form a loop');
            const parentAgent = parent.kind === "team" ? parent.leaderAgentId : parent.person.kind === "agent" ? parent.person.id : null;
            if (ownAgent && parentAgent === ownAgent && differentAgent) throw Error('An agent cannot report back to one of its own descendants');
            if (parentAgent && parentAgent !== ownAgent) differentAgent = true;
            visited.add(parentId); parentId = parent.parentId;
        }
        const parent = n.parentId ? byId.get(n.parentId) : null;
        if (parent && organizationTeamAncestor(nodes, parent.id)) throw Error('Team members cannot manage branches. Add another team under a company leader instead');
        if (n.kind === 'team' && parent?.kind === 'team') throw Error('Teams cannot contain other teams. Add a sibling team under its manager');
        if (n.kind === 'person' && n.person.kind === 'human' && parent && !(parent.kind === 'person' && parent.person.kind === 'human')) throw Error('Human executives belong above AI agents');
        if (n.kind === 'person' && parent?.kind === 'person' && parent.person.kind === n.person.kind && parent.person.id === n.person.id) throw Error('An agent cannot report to itself');
        if (n.kind === 'person' && parent?.kind === 'team' && n.person.kind === 'agent' && n.person.id === parent.leaderAgentId) throw Error('The team leader is already represented on this team');
    }
    for (const node of nodes) if (node.kind === 'person' && node.person.kind === 'human') {
        const below = new Set([node.id]); let count = 0;
        while (count !== below.size) { count = below.size; for (const child of nodes) if (child.parentId && below.has(child.parentId)) below.add(child.id); }
        if (!nodes.some(child => below.has(child.id) && child.id !== node.id && (child.kind === 'team' || (child.kind === 'person' && child.person.kind === 'agent')))) throw Error('Add an AI leader beneath each human executive');
    }
    return nodes.map(n => n.kind === 'person' ? {id:n.id,parentId:n.parentId,kind:n.kind,person:{kind:n.person.kind,id:n.person.id}} : {id:n.id,parentId:n.parentId,kind:n.kind,teamId:n.teamId,leaderAgentId:n.leaderAgentId});
}
export function removeOrganizationBranch(nodes: OrganizationNode[], id: string) {
    const removed = new Set([id]); let count = 0;
    while (count !== removed.size) { count=removed.size; for (const n of nodes) if (n.parentId && removed.has(n.parentId)) removed.add(n.id); }
    return nodes.filter(n => !removed.has(n.id));
}

/** The containing team, excluding the node itself. Also works for legacy trees. */
export function organizationTeamAncestor(nodes: OrganizationNode[], id: string): Extract<OrganizationNode, {kind:'team'}> | null {
    const byId = new Map(nodes.map(node => [node.id,node]));
    const seen = new Set<string>();
    let node = byId.get(id);
    while (node?.parentId && !seen.has(node.parentId)) {
        seen.add(node.parentId);
        node = byId.get(node.parentId);
        if (node?.kind === 'team') return node;
    }
    return null;
}
