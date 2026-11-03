import type { GroupSummary } from "./groups";
import type { OrganizationNode } from "./organization-tree";

/**
 * What an agent knows about the org chart: its managers per context, direct
 * reports, peers, chain of command and a compact tree of the whole company.
 * Pure (no database), so the GET /organization route, the MCP tool, the lean
 * context, task routing and the Company Brain note all read one shape.
 * A reporting relationship guides coordination; it never grants permission.
 */

export type OrgKind = "agent" | "human";
export type OrgPerson = { kind: OrgKind; id: string; name: string; role?: string | null };
export type OrgName = { id: string; name: string; kind: OrgKind; role?: string | null };
export type OrgReportingLine = { nodeId: string; teamId: string | null; context: string; reportsTo: OrgPerson | null };
export type OrgManager = { teamId: string | null; context: string; manager: OrgPerson };

/** Lines of the compact whole-company tree an agent receives. */
export const ORGANIZATION_TREE_MAX_PEOPLE = 60;
/** How many names one summary list shows before "+N more". */
export const ORGANIZATION_LIST_MAX = 5;
/** Longest name in the tree; in one-line lists; role; team title. */
const NAME_MAX = 48;
const LIST_NAME_MAX = 32;
const ROLE_MAX = 60;
const TITLE_MAX = 80;

/** One name for anyone the chart cannot name (a deleted agent, a person without a display name). */
const unnamed = (kind: OrgKind) => kind === "human" ? "A person" : "An agent";

/** What every agent is told about reporting lines (also in the org chart note). Agents follow it literally. */
export const ORGANIZATION_REPORTING_RULE = [
    "- A reporting line guides coordination; it never grants permission. You may still ask anyone you can reach.",
    "- Your manager depends on the work: use the task or conversation team to pick the reporting line. Working in another team's chat is collaboration, not a new reporting line.",
    "- Each task has one coordinating owner; joining a team never transfers task ownership. Approvals and access rules still apply.",
    "- When you set a task done or blocked, Emperor tells your manager for that team if the manager is an agent not already on the task. Otherwise (a human manager, or a manager who created or owns the task), report it as you normally would.",
    "- Escalate conflicting priorities or unclear ownership up your chain to the company leader, or to the humans if you lead the company. Send updates only when useful; never start reporting loops.",
].join("\n");

/** Display text from user-set names: one line, no control or bidi characters, capped. */
export function orgText(value: unknown, max = NAME_MAX): string {
    const clean = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

type Ref = { kind: OrgKind; id: string };
const sameRef = (a: Ref, b: Ref) => a.kind === b.kind && a.id === b.id;
const holderOf = (node: OrganizationNode): Ref => node.kind === "person" ? node.person : { kind: "agent", id: node.leaderAgentId };

/** Where each person sits: their own node, or (a team member not placed on the chart) under the team node. */
type Position = { holder: Ref; nodeId: string | null; parentNodeId: string | null };

/** Agents with a management place on the chart: the root, team leaders, and anyone with people under them. */
export function chartManagerAgentIds(nodes: OrganizationNode[], rootAgentId: string | null): Set<string> {
    const ids = new Set<string>(rootAgentId ? [rootAgentId] : []);
    for (const node of nodes) {
        if (node.kind === "team") ids.add(node.leaderAgentId);
        else if (node.person.kind === "agent" && nodes.some((child) => child.parentId === node.id)) ids.add(node.person.id);
    }
    return ids;
}

function chartPositions(nodes: OrganizationNode[], teams: GroupSummary[], rootAgentId: string | null): Position[] {
    const positions: Position[] = nodes.map((node) => ({ holder: holderOf(node), nodeId: node.id, parentNodeId: node.parentId }));
    const teamLeaders = chartManagerAgentIds(nodes, rootAgentId);
    for (const node of nodes) {
        if (node.kind !== "team") continue;
        const group = teams.find((team) => team.id === node.teamId);
        for (const member of group?.members ?? []) {
            if (member.kind !== "agent" || teamLeaders.has(member.id)) continue;
            if (nodes.some((child) => child.parentId === node.id && child.kind === "person" && child.person.kind === "agent" && child.person.id === member.id)) continue;
            positions.push({ holder: { kind: "agent", id: member.id }, nodeId: null, parentNodeId: node.id });
        }
    }
    return positions;
}

function uniquePeople(people: OrgPerson[]): OrgPerson[] {
    const seen = new Set<string>();
    return people.filter((person) => {
        const key = `${person.kind}:${person.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export type OrganizationTreeInput = {
    nodes: OrganizationNode[];
    leader: Ref | null;
    /** The chart's teams (company groups on the chart). */
    teams: GroupSummary[];
    names: OrgName[];
    /** Marked "(you)". */
    agentId?: string | null;
    /** Agents outside this set are shown without a name or role. */
    visibleAgentIds?: ReadonlySet<string> | null;
    maxPeople?: number;
};

/**
 * The whole company as an indented Markdown list: people with their role,
 * teams with their leader, members under their team. Capped at maxPeople
 * lines, then one "+N more" line.
 */
export function organizationTreeText(input: OrganizationTreeInput): string {
    const { nodes, teams, names } = input;
    const max = input.maxPeople ?? ORGANIZATION_TREE_MAX_PEOPLE;
    const label = (ref: Ref) => {
        if (ref.kind === "agent" && input.visibleAgentIds && !input.visibleAgentIds.has(ref.id)) return "(an agent outside your access)";
        const entry = names.find((name) => name.kind === ref.kind && name.id === ref.id);
        const name = orgText(entry?.name) || unnamed(ref.kind);
        const role = orgText(entry?.role, ROLE_MAX);
        const self = ref.kind === "agent" && ref.id === input.agentId ? " (you)" : "";
        return `${name}${role ? ` — ${role}` : ""}${ref.kind === "human" ? " (human)" : ""}${self}`;
    };
    const teamTitle = (teamId: string) => orgText(teams.find((team) => team.id === teamId)?.title, TITLE_MAX) || "Team";
    const lines: string[] = [];
    const push = (depth: number, text: string) => lines.push(`${"  ".repeat(depth)}- ${text}`);

    if (nodes.length) {
        const rootAgentId = input.leader?.kind === "agent" ? input.leader.id : null;
        const positions = chartPositions(nodes, teams, rootAgentId);
        const seen = new Set<string>();
        const walk = (node: OrganizationNode, depth: number) => {
            if (seen.has(node.id)) return;
            seen.add(node.id);
            push(depth, node.kind === "team" ? `Team ${teamTitle(node.teamId)}, led by ${label(holderOf(node))}` : label(node.person));
            for (const child of nodes) if (child.parentId === node.id) walk(child, depth + 1);
            for (const position of positions) if (position.nodeId === null && position.parentNodeId === node.id) push(depth + 1, label(position.holder));
        };
        for (const root of nodes.filter((node) => node.parentId === null)) walk(root, 0);
    } else if (input.leader || teams.length) {
        // A chart saved before reporting trees: the leader and its teams.
        if (input.leader) push(0, `${label(input.leader)} — company leader`);
        for (const team of teams) {
            const coordinator = team.coordinator;
            push(input.leader ? 1 : 0, `Team ${orgText(team.title, TITLE_MAX) || "Team"}${coordinator ? `, coordinated by ${label(coordinator)}` : ""}`);
            for (const member of team.members) {
                if (member.kind !== "agent" || (coordinator && sameRef(member, coordinator)) || (input.leader && sameRef(member, input.leader))) continue;
                push(input.leader ? 2 : 1, label(member));
            }
        }
    }
    if (lines.length <= max) return lines.join("\n");
    return [...lines.slice(0, max), `- … +${lines.length - max} more (get_organization or GET /organization)`].join("\n");
}

/** Short list of names: "A, B and 3 more". */
export function orgNameList(people: readonly { name: string }[], max = ORGANIZATION_LIST_MAX): string {
    const names = people.map((person) => orgText(person.name, LIST_NAME_MAX)).filter(Boolean);
    if (names.length <= max) return names.join(", ");
    return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/** The one-line "You report to X; your direct reports: …" for the lean context. */
export function organizationSummaryLine(briefing: { configured?: boolean; isCompanyLeader: boolean; managers: OrgManager[]; directReports: OrgPerson[]; leader: OrgPerson | null }): string {
    if (briefing.configured === false) return "";
    const reports = briefing.directReports.length ? `; your direct reports: ${orgNameList(briefing.directReports)}` : "";
    if (briefing.isCompanyLeader) return `Org chart: you lead the company and report to the humans${reports}.`;
    const managers = briefing.managers.slice(0, 3).map(({ manager, context, teamId }) => `${orgText(manager.name, LIST_NAME_MAX)}${teamId ? ` (${orgText(context, LIST_NAME_MAX)})` : ""}`);
    if (managers.length) return `Org chart: you report to ${managers.join(" and ")}${reports}.`;
    if (reports) return `Org chart: ${reports.slice(2)}.`;
    return briefing.leader ? `Org chart: no reporting line yet; escalate to the company leader ${orgText(briefing.leader.name, LIST_NAME_MAX)}.` : "";
}

/** The manager for a piece of work: the line in the work's team, else the first line. */
export function pickChartManager(managers: readonly OrgManager[], contextTeamIds: readonly string[]): OrgPerson | null {
    for (const teamId of contextTeamIds) {
        const line = managers.find((entry) => entry.teamId === teamId);
        if (line) return line.manager;
    }
    return managers[0]?.manager ?? null;
}

export type OrganizationBriefingOptions = {
    /** The viewer's agent allow-list: out-of-reach agents are left out (never named). */
    visibleAgentIds?: ReadonlySet<string> | null;
    maxPeople?: number;
};

type Relations = { managers: OrgManager[]; directReports: OrgPerson[]; peers: OrgPerson[]; chainOfCommand: OrgPerson[] };
type Lookup = (kind: OrgKind, id: string) => OrgPerson;

/** Managers, reports, peers and chain from a reporting tree. */
function chartRelations(nodes: OrganizationNode[], teams: GroupSummary[], self: Ref, rootAgentId: string | null, reporting: OrgReportingLine[], lookup: Lookup): Relations {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const positions = chartPositions(nodes, teams, rootAgentId);
    const mine = positions.filter(position => sameRef(position.holder, self));
    const ownNodeIds = new Set(mine.flatMap(position => position.nodeId ? [position.nodeId] : []));
    const parents = new Set(mine.flatMap(position => position.parentNodeId ? [position.parentNodeId] : []));
    const others = positions.filter(position => !sameRef(position.holder, self));
    const people = (keep: (position: Position) => boolean) => uniquePeople(others.filter(keep).map(position => lookup(position.holder.kind, position.holder.id)));
    // The chain follows the first reporting line up to the top of the chart.
    const first = reporting[0] ? mine.find(position => position.nodeId === reporting[0].nodeId) ?? { holder: self, nodeId: null, parentNodeId: reporting[0].nodeId } : mine[0];
    const chainOfCommand: OrgPerson[] = [];
    const seen = new Set<string>();
    for (let parentId = first?.parentNodeId ?? null; parentId && !seen.has(parentId);) {
        seen.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) break;
        const holder = holderOf(parent);
        if (!sameRef(holder, self)) chainOfCommand.push(lookup(holder.kind, holder.id));
        parentId = parent.parentId;
    }
    return {
        managers: reporting.flatMap(line => line.reportsTo ? [{ teamId: line.teamId, context: line.context, manager: line.reportsTo }] : []),
        directReports: people(position => Boolean(position.parentNodeId && ownNodeIds.has(position.parentNodeId))),
        peers: people(position => Boolean(position.parentNodeId && parents.has(position.parentNodeId))),
        chainOfCommand,
    };
}

/** The same from a chart saved before reporting trees: team coordinators, then the leader. */
function legacyRelations(own: GroupSummary[], teams: GroupSummary[], self: Ref, leader: Ref | null, isCompanyLeader: boolean, lookup: Lookup): Relations {
    const managers: OrgManager[] = [];
    const directReports: OrgPerson[] = [];
    const peers: OrgPerson[] = [];
    const otherAgents = (team: GroupSummary, except: Ref | null) => team.members.filter(m => m.kind === "agent" && !sameRef(m, self) && !(except && sameRef(m, except))).map(m => lookup("agent", m.id));
    for (const team of own) {
        const coordinator = team.coordinator;
        const coordinatesIt = Boolean(coordinator && sameRef(coordinator, self));
        const manager = coordinator && !coordinatesIt ? lookup(coordinator.kind, coordinator.id) : coordinatesIt && leader && !isCompanyLeader ? lookup(leader.kind, leader.id) : null;
        if (manager) managers.push({ teamId: team.id, context: team.title, manager });
        if (coordinatesIt) directReports.push(...otherAgents(team, null));
        else peers.push(...otherAgents(team, coordinator));
    }
    if (isCompanyLeader) directReports.push(...teams.flatMap(team => team.coordinator && !sameRef(team.coordinator, self) ? [lookup(team.coordinator.kind, team.coordinator.id)] : []));
    const chainOfCommand = managers.slice(0, 1).map(entry => entry.manager);
    if (leader && !isCompanyLeader) chainOfCommand.push(lookup(leader.kind, leader.id));
    return { managers, directReports: uniquePeople(directReports), peers: uniquePeople(peers), chainOfCommand };
}

/** A reporting relationship guides coordination; it never grants permission. */
export function organizationBriefing(leader: { kind: string; id: string; name: string } | null, teams: GroupSummary[], agentId: string, nodes: OrganizationNode[] = [], names: OrgName[] = [], options: OrganizationBriefingOptions = {}) {
    const own = teams.filter(team => team.members.some(member => member.kind === "agent" && member.id === agentId));
    const lookup: Lookup = (kind, id) => {
        const entry = names.find(p => p.kind === kind && p.id === id);
        return entry ? { kind, id, name: entry.name, ...(entry.role ? { role: entry.role } : {}) } : { kind, id, name: unnamed(kind) };
    };
    const reporting: OrgReportingLine[] = nodes.filter(n => (n.kind === "person" && n.person.kind === "agent" && n.person.id === agentId) || (n.kind === "team" && n.leaderAgentId === agentId)).map(n => {
        const parent = nodes.find(p => p.id === n.parentId);
        const target = parent?.kind === "person" ? lookup(parent.person.kind, parent.person.id) : parent?.kind === "team" ? lookup("agent", parent.leaderAgentId) : null;
        let containing = parent;
        while (containing?.kind === "person") containing = nodes.find(p => p.id === containing!.parentId);
        const teamId = n.kind === "team" ? n.teamId : containing?.kind === "team" ? containing.teamId : null;
        return { nodeId: n.id, teamId, context: teamId ? teams.find(t => t.id === teamId)?.title ?? "Team" : "Direct reporting", reportsTo: target && !(target.kind === "agent" && target.id === agentId) ? target : null };
    });
    const leaderRef: Ref | null = leader ? { kind: leader.kind as OrgKind, id: leader.id } : null;
    const rootAgentId = leaderRef?.kind === "agent" ? leaderRef.id : null;
    const self: Ref = { kind: "agent", id: agentId };
    const isCompanyLeader = rootAgentId === agentId;
    // Leaders and managers keep their chart line; a team chat they sit in is collaboration.
    const dedicatedLeader = isCompanyLeader || chartManagerAgentIds(nodes, rootAgentId).has(agentId);
    if (nodes.length && !dedicatedLeader) for (const team of own) {
        if (reporting.some(r => r.teamId === team.id)) continue;
        const node = nodes.find(n => n.kind === "team" && n.teamId === team.id);
        if (node?.kind === "team") reporting.push({ nodeId: node.id, teamId: team.id, context: team.title, reportsTo: lookup("agent", node.leaderAgentId) });
    }

    const relations = nodes.length ? chartRelations(nodes, teams, self, rootAgentId, reporting, lookup) : legacyRelations(own, teams, self, leaderRef, isCompanyLeader, lookup);
    // Not on the chart: the company leader is the contact.
    const reportsOnlyToLeader = Boolean(leaderRef && !isCompanyLeader && !relations.chainOfCommand.length && !sameRef(leaderRef, self));
    const chainOfCommand = uniquePeople(reportsOnlyToLeader && leaderRef ? [lookup(leaderRef.kind, leaderRef.id)] : relations.chainOfCommand);

    // An agent limited to certain agents never learns the others' names or ids.
    const reach = options.visibleAgentIds ?? null;
    const visible = <T extends OrgPerson | { kind: string; id: string; name: string }>(person: T | null): T | null => !reach || !person || person.kind !== "agent" || reach.has(person.id) ? person : null;
    const keep = (people: OrgPerson[]) => people.filter(person => visible(person));
    const chainTop = chainOfCommand[chainOfCommand.length - 1];
    const endsWithHumans = isCompanyLeader || !chainTop || chainTop.kind === "agent";
    const chainSummary = [...(isCompanyLeader ? [] : keep(chainOfCommand).map(person => orgText(person.name, LIST_NAME_MAX))), ...(endsWithHumans ? ["the humans"] : [])].join(" → ");

    const briefing = {
        reporting: reporting.map(line => ({ ...line, reportsTo: visible(line.reportsTo) })),
        leader: visible(leader),
        teams: own.map(team => ({ id: team.id, name: team.title, purpose: team.description, coordinator: visible(team.coordinator ? { kind: team.coordinator.kind, id: team.coordinator.id, name: team.coordinator.name } : null) })),
        reportingRule: ORGANIZATION_REPORTING_RULE,
        isCompanyLeader,
        managers: relations.managers.filter(entry => visible(entry.manager)),
        directReports: keep(relations.directReports),
        peers: keep(relations.peers),
        chainOfCommand: keep(chainOfCommand),
        chainSummary,
        tree: organizationTreeText({ nodes, leader: leaderRef, teams, names, agentId, visibleAgentIds: reach, maxPeople: options.maxPeople }),
    };
    return { ...briefing, summary: organizationSummaryLine({ ...briefing, leader: briefing.leader as OrgPerson | null }) };
}

export type OrganizationBriefing = ReturnType<typeof organizationBriefing>;

export const ORGANIZATION_NOTE_NAME = "organization-chart";
export const ORGANIZATION_NOTE_DISPLAY_NAME = "Organization chart";
export const ORGANIZATION_NOTE_PATH = "Company";

/** The generated org chart note (company scope, fixed name): the marker access checks use. */
export function isOrganizationNote(resource: { scopeType: string; name: string }): boolean {
    return resource.scopeType === "company" && resource.name === ORGANIZATION_NOTE_NAME;
}
export const ORGANIZATION_NOTE_SUMMARY = "Who reports to whom: the company leader, each team with its lead, and its members. Generated from the organization chart.";
export const ORGANIZATION_NOTE_HEADER = "> Generated by Emperor Claw from the organization chart. Edits made here are replaced at the next chart, team or agent change (earlier versions stay in this note's history). Change the chart in Agents → Organization instead.";

/** The Company Brain note: the rendered tree and the reporting rule. */
export function renderOrganizationNote(input: { companyName: string; tree: string }): string {
    return [
        ORGANIZATION_NOTE_HEADER,
        "",
        `# Organization chart — ${orgText(input.companyName, TITLE_MAX) || "Company"}`,
        "",
        input.tree || "No organization chart yet. Choose a company leader and add teams in Agents → Organization.",
        "",
        "## Reporting rule",
        "",
        ORGANIZATION_REPORTING_RULE,
    ].join("\n");
}
