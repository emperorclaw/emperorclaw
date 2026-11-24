import type { GroupSummary } from "./groups";
import { validateOrganizationTree, type OrganizationNode } from "./organization-tree";

/**
 * The chart the app renders, brought in line with the rooms it names.
 *
 * `companies.organization_json.nodes` is a snapshot written by the chart editor
 * (Agents → Organization): a team node carries the leader's agent id and every
 * member is a person node. The room itself is edited elsewhere (Messages → the
 * room: members and coordinator) and nothing ever wrote that back, so a saved
 * chart kept naming a former coordinator, members who had left and agents that
 * no longer exist — the tree then printed those as "An agent".
 *
 * A room and its `coordinator` are the source of truth for who is in a team and
 * who leads it; the snapshot only says where people sit. Reconciling on read
 * (never on write) makes every reader see the same live structure — the MCP
 * tree, the chart page, routing and the Company Brain note — and the chart page
 * persists the cleaned chart the next time someone saves it. The editor already
 * writes the other way (a chart save adds/removes room members and patches the
 * coordinator), so a room change and a chart change converge from either side.
 */

/** Who still exists: the company's agents and its people. */
export type ChartLive = {
    agentIds: ReadonlySet<string>;
    personIds: ReadonlySet<string>;
};

export function chartLive(roster: readonly { id: string }[], people: readonly { id: string }[]): ChartLive {
    return { agentIds: new Set(roster.map((agent) => agent.id)), personIds: new Set(people.map((person) => person.id)) };
}

const isLive = (live: ChartLive, kind: "agent" | "human", id: string) => (kind === "agent" ? live.agentIds.has(id) : live.personIds.has(id));
const isMember = (group: GroupSummary, kind: "agent" | "human", id: string) => group.members.some((member) => member.kind === kind && member.id === id);
const holderId = (node: OrganizationNode) => (node.kind === "team" ? node.leaderAgentId : node.person.id);

/**
 * The AI that leads a room: the room's coordinator while it is a live member,
 * else the leader the chart already had.
 *
 * No peer is ever promoted to lead: a member who took over a missing
 * coordinator would end up reporting to itself, and the chart would stop
 * meaning what routing reads from it. A room whose coordinator was removed is
 * an upstream data problem, and the chart keeps the leader it was saved with.
 *
 * `taken` holds the leaders already chosen for other rooms: one agent leads one
 * team on the chart, and the company's AI leader leads none of them.
 */
function roomLeader(group: GroupSummary, savedLeaderId: string, rootAgentId: string | null, taken: ReadonlySet<string>, live: ChartLive): string | null {
    const coordinator = group.coordinator?.kind === "agent" ? group.coordinator.id : null;
    const isLiveMember = !!coordinator && live.agentIds.has(coordinator) && group.members.some((member) => member.kind === "agent" && member.id === coordinator);
    if (isLiveMember && coordinator !== rootAgentId && !taken.has(coordinator)) return coordinator;
    return savedLeaderId || null;
}

/** A human executive needs an AI below it; a human left bare by the drops goes too. */
function dropBareHumans(nodes: OrganizationNode[]): OrganizationNode[] {
    let current = nodes;
    for (let pass = 0; pass <= nodes.length; pass += 1) {
        const bare = (node: OrganizationNode) => node.kind === "person" && node.person.kind === "human" && !current.some((child) => child.parentId === node.id);
        if (!current.some(bare)) return current;
        current = current.filter((node) => !bare(node));
    }
    return current;
}

/**
 * The stored chart with every room's live coordinator and membership applied.
 * Pure — it never reads or writes the database, so it is unit-tested directly.
 */
export function reconcileOrganizationChart(
    nodes: readonly OrganizationNode[] | undefined,
    groups: readonly GroupSummary[],
    live: ChartLive,
): OrganizationNode[] {
    if (!nodes?.length) return [];
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const root = nodes.find((node) => node.parentId === null);
    const rootAgentId = root?.kind === "person" && root.person.kind === "agent" ? root.person.id : null;

    /** The leader each kept team node ended up with, so its own leader is not drawn twice. */
    const leaderOfNode = new Map<string, string>();

    /** The node as it stands today, or null when the person or the room is gone. */
    const liveNode = (node: OrganizationNode, parent: OrganizationNode | null, taken: Set<string>): OrganizationNode | null => {
        if (node.kind === "person") {
            if (!isLive(live, node.person.kind, node.person.id)) return null;
            if (!parent || parent.kind !== "team") return node;
            const team = groupsById.get(parent.teamId);
            if (!team || !isMember(team, node.person.kind, node.person.id)) return null;
            // The team node already stands for its leader; a saved member node
            // for the same agent would draw that person twice.
            return node.person.kind === "agent" && node.person.id === leaderOfNode.get(parent.id) ? null : node;
        }
        const group = groupsById.get(node.teamId);
        if (!group) return null;
        const leader = roomLeader(group, node.leaderAgentId, rootAgentId, taken, live);
        if (!leader) return null;
        taken.add(leader);
        leaderOfNode.set(node.id, leader);
        return leader === node.leaderAgentId ? node : { ...node, leaderAgentId: leader };
    };

    const kept: OrganizationNode[] = [];
    const taken = new Set<string>();
    const seen = new Set<string>();
    const visit = (node: OrganizationNode) => {
        if (seen.has(node.id)) return;
        seen.add(node.id);
        const parent = node.parentId === null ? null : byId.get(node.parentId) ?? null;
        if (node.parentId !== null && !parent) return;
        const keptNode = liveNode(node, parent, taken);
        if (!keptNode) return;
        kept.push(keptNode);
        for (const child of nodes) if (child.parentId === node.id) visit(child);
    };
    for (const node of nodes) if (node.parentId === null) visit(node);

    // Agent members of a room who sit nowhere on the chart join their team node,
    // so a member added to the room shows up on the next read. Leaders, the
    // company AI leader and anyone already placed elsewhere stay where they are.
    const withMembers = dropBareHumans(kept);
    const leaders = new Set(withMembers.flatMap((node) => (node.kind === "team" ? [node.leaderAgentId] : node.person.kind === "agent" ? [node.person.id] : [])));
    const placed = new Set<string>(withMembers.map(holderId));
    const ids = new Set(withMembers.map((node) => node.id));
    for (const node of withMembers) {
        if (node.kind !== "team") continue;
        const group = groupsById.get(node.teamId);
        if (!group) continue;
        for (const member of group.members) {
            if (member.kind !== "agent" || !live.agentIds.has(member.id) || placed.has(member.id) || leaders.has(member.id)) continue;
            const base = `member-${node.teamId}-${member.id}`;
            let id = base.slice(0, 100);
            for (let n = 2; ids.has(id); n += 1) id = `${base.slice(0, 96)}-${n}`;
            ids.add(id);
            placed.add(member.id);
            withMembers.push({ id, parentId: node.id, kind: "person", person: { kind: "agent", id: member.id } });
        }
    }
    // A hand-edited row the drops left invalid still reads: serve the reconciled
    // chart rather than fail a GET on data the editor will refuse to save anyway.
    try {
        return validateOrganizationTree(withMembers);
    } catch {
        return withMembers;
    }
}

/** The rooms a chart names, for the flat team list on the stored config. */
export function chartTeamIds(nodes: readonly OrganizationNode[]): string[] {
    return [...new Set(nodes.flatMap((node) => (node.kind === "team" ? [node.teamId] : [])))];
}
