import { organizationTeamAncestor, validateOrganizationTree, type OrganizationNode } from "./organization-tree";

/**
 * Placing a team on the org chart during setup (wizard, easy setup): a team
 * node under the company's AI leader, led by the team's coordinator, with its
 * other agents under it. Only adds; never moves or removes what is there.
 * Pure, so it is unit-tested against the chart validation.
 */
export type ChartTeam = { teamId: string; coordinatorAgentId: string | null; memberAgentIds: readonly string[] };

function uniqueId(base: string, taken: Set<string>): string {
    let id = base.slice(0, 100);
    for (let n = 2; taken.has(id); n += 1) id = `${base.slice(0, 92)}-${n}`;
    taken.add(id);
    return id;
}

export function rootChartNode(agentId: string): OrganizationNode {
    return { id: `leader-${agentId}`, parentId: null, kind: "person", person: { kind: "agent", id: agentId } };
}

/** The chart with the team added, or null when it is already there or cannot be placed validly. */
export function addTeamToChart(nodes: OrganizationNode[], team: ChartTeam): OrganizationNode[] | null {
    if (nodes.some((node) => node.kind === "team" && node.teamId === team.teamId)) return null;
    const root = nodes.find((node) => node.parentId === null);
    if (!root || root.kind !== "person") return null;
    const rootAgent = root.person.kind === "agent" ? root.person.id : null;
    // Under the company's AI leader: the root, or the first AI directly under a human root.
    const parent = rootAgent ? root : nodes.find((node) => node.parentId === root.id && node.kind === "person" && node.person.kind === "agent") ?? root;
    const leaders = new Set(nodes.flatMap((node) => node.kind === "team" ? [node.leaderAgentId] : []));
    const teammates = new Set(nodes.flatMap((node) => node.kind === "person" && node.person.kind === "agent" && organizationTeamAncestor(nodes, node.id) ? [node.person.id] : []));
    const parentAgent = parent.kind === "person" && parent.person.kind === "agent" ? parent.person.id : null;
    // Already reporting straight to that leader (a first chart without a team node): placing
    // them again under a new team would list them twice.
    const directReports = new Set(nodes.flatMap((node) => node.parentId === parent.id && node.kind === "person" && node.person.kind === "agent" ? [node.person.id] : []));
    const eligible = (id: string) => id !== rootAgent && id !== parentAgent && !leaders.has(id) && !teammates.has(id) && !directReports.has(id);
    const leader = [team.coordinatorAgentId, ...team.memberAgentIds].find((id): id is string => Boolean(id) && eligible(id!));
    if (!leader) return null;
    const taken = new Set(nodes.map((node) => node.id));
    const teamNode: OrganizationNode = { id: uniqueId(`team-${team.teamId}`, taken), parentId: parent.id, kind: "team", teamId: team.teamId, leaderAgentId: leader };
    const members: OrganizationNode[] = [...new Set(team.memberAgentIds)]
        .filter((id) => id !== leader && id !== rootAgent && id !== parentAgent && !leaders.has(id) && !directReports.has(id))
        .map((id) => ({ id: uniqueId(`member-${team.teamId}-${id}`, taken), parentId: teamNode.id, kind: "person", person: { kind: "agent", id } }));
    try {
        return validateOrganizationTree([...nodes, teamNode, ...members]);
    } catch {
        return null;
    }
}

/**
 * A first chart for a company that has none. The root is the chosen AI
 * leader, under the person who set it up when one is given (a human executive
 * sits above AI agents); when that AI leader is also the team's coordinator
 * (easy setup's one team), the members report to it directly instead of
 * through a team node.
 */
export function initialChart(rootAgentId: string, team: ChartTeam, humanId?: string | null): OrganizationNode[] {
    const base: OrganizationNode[] = humanId
        ? [{ id: `human-${humanId}`, parentId: null, kind: "person", person: { kind: "human", id: humanId } }, { ...rootChartNode(rootAgentId), parentId: `human-${humanId}` }]
        : [rootChartNode(rootAgentId)];
    const aiLeader = base[base.length - 1];
    const withTeam = team.coordinatorAgentId === rootAgentId ? null : addTeamToChart(base, team);
    if (withTeam) return withTeam;
    const taken = new Set(base.map((node) => node.id));
    const members: OrganizationNode[] = [...new Set(team.memberAgentIds)].filter((id) => id !== rootAgentId)
        .map((id) => ({ id: uniqueId(`member-${id}`, taken), parentId: aiLeader.id, kind: "person", person: { kind: "agent", id } }));
    try {
        return validateOrganizationTree([...base, ...members]);
    } catch {
        return base;
    }
}
