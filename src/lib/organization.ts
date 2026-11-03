import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, companies, companyMembers, users } from "@/db/schema";
import { GroupError, listGroups } from "@/lib/groups";
import { coerceStoredOrganization, validateOrganizationTree, type OrganizationNode, type StoredOrganization } from "@/lib/organization-tree";
import { organizationBriefing, type OrgName } from "@/lib/organization-briefing";
import { cachedOrganization, invalidateOrganizationCache } from "@/lib/organization-cache";
import { addTeamToChart, initialChart, type ChartTeam } from "@/lib/organization-setup";
import { mcpAccessForAgent } from "@/lib/mcp-access";
import type { CoordinatorRef } from "@/lib/team-coordination";

/** flatTeamIds: teams setup placed without a team node (members directly under the leader). */
export type OrganizationConfig = StoredOrganization;
export function parseOrganization(input: unknown): OrganizationConfig {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new GroupError("Invalid organization", 400);
    const value = input as Record<string, unknown>;
    const leader = value.leader;
    if (leader !== null && (!leader || typeof leader !== "object" || !["agent", "human"].includes((leader as CoordinatorRef).kind) || typeof (leader as CoordinatorRef).id !== "string")) throw new GroupError("Choose one company leader", 400);
    if (!Array.isArray(value.teamIds) || value.teamIds.length > 200 || value.teamIds.some(id => typeof id !== "string" || !id)) throw new GroupError("Invalid teams", 400);
    let nodes: OrganizationNode[] | undefined;
    if (value.nodes !== undefined) { try { nodes = validateOrganizationTree(value.nodes); } catch (error) { throw new GroupError(error instanceof Error ? error.message : "Invalid chart", 400); } }
    return { ...(nodes ? {nodes} : {}), leader: leader ? { kind: (leader as CoordinatorRef).kind, id: (leader as CoordinatorRef).id } : null, teamIds: [...new Set(value.teamIds as string[])] };
}
export async function loadOrganization(companyId: string) {
    const [[company], roster, people, groups] = await Promise.all([
        db.select({ name: companies.name, config: companies.organizationJson }).from(companies).where(and(eq(companies.id, companyId), isNull(companies.deletedAt))),
        db.select({ id: agents.id, name: agents.name, role: agents.role, avatarUrl: agents.avatarUrl, avatarAppearance: agents.avatarAppearance, status: agents.status }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
        db.select({ id: users.id, name: users.displayName, role: users.roleTitle }).from(companyMembers).innerJoin(users, eq(companyMembers.userId, users.id)).where(and(eq(companyMembers.companyId, companyId), isNull(users.deletedAt))),
        listGroups(companyId, { includePairThreads: false }),
    ]);
    if (!company) throw new GroupError("Company not found", 404);
    const stored: OrganizationConfig = coerceStoredOrganization(company.config) ?? { leader: null, teamIds: [] };
    const config = { ...stored, teamIds: stored.teamIds.filter(id => groups.some(group => group.id === id)) };
    const leader = config.leader ? (config.leader.kind === "agent" ? roster : people).find(member => member.id === config.leader!.id) : null;
    if (config.leader && !leader) config.leader = null;
    const teams = groups.filter(group => config.teamIds.includes(group.id));
    return { companyName: company.name, configured: !!company.config, config, leader: leader ? { ...config.leader!, name: leader.name || "Teammate" } : null, roster, people: people.map(p => ({ ...p, name: p.name || "Teammate" })), groups, teams };
}
export async function saveOrganization(companyId: string, input: unknown, initialize = false) {
    const config = parseOrganization(input);
    const current = await loadOrganization(companyId);
    if (config.leader && !(config.leader.kind === "agent" ? current.roster : current.people).some(member => member.id === config.leader!.id)) throw new GroupError("Leader must belong to this company", 400);
    if (config.teamIds.some(id => !current.groups.some(group => group.id === id))) throw new GroupError("Teams must be active company groups", 400);
    if (config.nodes) {
        for (const node of config.nodes) {
            if (node.kind === "person" && !(node.person.kind === "agent" ? current.roster : current.people).some(p => p.id === node.person.id)) throw new GroupError("Chart members must belong to this company", 400);
            if (node.kind === "team") {
                const team = current.groups.find(g => g.id === node.teamId);
                if (!team || !current.roster.some(a => a.id === node.leaderAgentId) || !team.members.some(m => m.kind === "agent" && m.id === node.leaderAgentId)) throw new GroupError("Each team needs an AI leader who is a member", 400);
            }
            let parent = config.nodes.find(p => p.id === node.parentId);
            if (node.kind === "person") { while (parent?.kind === "person") parent = config.nodes.find(p => p.id === parent!.parentId); }
            if (node.kind === "person" && parent?.kind === "team" && !current.groups.find(g => g.id === parent.teamId)?.members.some(m => m.kind === node.person.kind && m.id === node.person.id)) throw new GroupError("Add this agent to the team before placing it on the chart", 400);
        }
        const root = config.nodes.find(n => n.parentId === null);
        config.leader = root?.kind === "person" ? root.person : null;
        config.teamIds = config.nodes.filter(n => n.kind === "team").map(n => n.teamId);
    }
    const changed = await db.update(companies).set({ organizationJson: config }).where(initialize ? and(eq(companies.id, companyId), isNull(companies.organizationJson)) : eq(companies.id, companyId)).returning({id: companies.id});
    if (!changed.length) throw new GroupError("Organization is already configured", 409);
    invalidateOrganizationCache(companyId);
    return config;
}
type LoadedOrganization = Awaited<ReturnType<typeof loadOrganization>>;

/** loadOrganization with a few seconds of in-process caching, for hot read paths (routing, lean context, instructions). */
export function loadOrganizationCached(companyId: string): Promise<LoadedOrganization> {
    return cachedOrganization(companyId, () => loadOrganization(companyId));
}

/** One cheap column read: has this company saved any chart? */
export async function isOrganizationConfigured(companyId: string): Promise<boolean> {
    const [row] = await db.select({ configured: sql<boolean>`${companies.organizationJson} IS NOT NULL` }).from(companies).where(eq(companies.id, companyId)).limit(1);
    return Boolean(row?.configured);
}

/** Everyone the chart can name: agents and company members, with their roles. */
export function organizationNames(org: LoadedOrganization): OrgName[] {
    return [
        ...org.roster.map(p => ({ id: p.id, name: p.name, kind: "agent" as const, role: p.role })),
        ...org.people.map(p => ({ id: p.id, name: p.name, kind: "human" as const, role: p.role })),
    ];
}

/**
 * One agent's place on the chart and the whole tree, trimmed to the agents it
 * may work with. Shared by GET /organization, the get_organization tool, the
 * lean context and work routing.
 */
export async function organizationForAgent(companyId: string, agentId: string | null, options: { org?: LoadedOrganization; maxPeople?: number } = {}) {
    const org = options.org ?? await loadOrganization(companyId);
    const visibleAgentIds = agentId ? (await mcpAccessForAgent(companyId, agentId)).allowedAgentIds : null;
    const briefing = organizationBriefing(org.leader, org.teams, agentId ?? "", org.config.nodes, organizationNames(org), { visibleAgentIds, maxPeople: options.maxPeople });
    return { configured: org.configured, companyName: org.companyName, ...briefing };
}

/** Last good one-line summary per agent, so a transient failure never changes what an agent is told (or a lean ETag). */
const lastSummaries = new Map<string, string>();
let summaryErrorLogged = false;

/**
 * The agent's one-line place on the chart ("Org chart: you report to …"), or
 * "" with no chart. Used by the lean context and MCP instructions. On an error
 * it serves the last good line (logged once per process), never throws.
 */
export async function organizationSummaryForAgent(companyId: string, agentId: string): Promise<string> {
    const key = `${companyId}:${agentId}`;
    try {
        const org = await loadOrganizationCached(companyId);
        const summary = org.configured ? (await organizationForAgent(companyId, agentId, { org })).summary : "";
        lastSummaries.set(key, summary);
        if (lastSummaries.size > 2000) lastSummaries.delete(lastSummaries.keys().next().value!);
        return summary;
    } catch (error) {
        if (!summaryErrorLogged) {
            summaryErrorLogged = true;
            console.warn("[organization] could not build an agent's org line; serving the last one:", error instanceof Error ? error.message : error);
        }
        return lastSummaries.get(key) ?? "";
    }
}

/**
 * Put an existing group on the chart as a team (setup wizard, easy setup).
 * Only adds: a chart someone already edited keeps every node, and a team that
 * cannot be placed validly (no eligible AI leader) leaves the chart as it is.
 * With no chart yet, one is started with rootAgentId (else the team's
 * coordinator) as the company's AI leader, under rootHumanId (the person
 * setting it up) when given. Serialized per company (row lock). onChart says
 * whether the team is on the chart afterwards.
 */
export async function attachTeamToOrganization(companyId: string, teamId: string, options: { rootAgentId?: string | null; rootHumanId?: string | null } = {}) {
    const current = await loadOrganization(companyId);
    const group = current.groups.find(g => g.id === teamId);
    if (!group) throw new GroupError("Teams must be active company groups", 400);
    const onRoster = (id: string) => current.roster.some(agent => agent.id === id);
    const memberAgentIds = group.members.filter(m => m.kind === "agent" && onRoster(m.id)).map(m => m.id);
    const coordinatorAgentId = group.coordinator?.kind === "agent" && onRoster(group.coordinator.id) ? group.coordinator.id : null;
    const team: ChartTeam = { teamId, coordinatorAgentId, memberAgentIds };
    const placed = (config: OrganizationConfig | null) => Boolean(config?.teamIds.includes(teamId) || config?.flatTeamIds?.includes(teamId));
    const result = await db.transaction(async tx => {
        const [company] = await tx.select({ config: companies.organizationJson }).from(companies).where(and(eq(companies.id, companyId), isNull(companies.deletedAt))).for("update");
        if (!company) throw new GroupError("Company not found", 404);
        const stored = coerceStoredOrganization(company.config);
        if (placed(stored)) return { changed: false, onChart: true, config: stored };
        let next: OrganizationConfig | null = null;
        if (!stored) {
            const rootId = [options.rootAgentId, coordinatorAgentId, memberAgentIds[0]].find((id): id is string => Boolean(id) && onRoster(id!));
            if (!rootId) return { changed: false, onChart: false, config: null };
            const humanId = options.rootHumanId && current.people.some(p => p.id === options.rootHumanId) ? options.rootHumanId : null;
            const nodes = initialChart(rootId, team, humanId);
            const teamIds = nodes.flatMap(n => n.kind === "team" ? [n.teamId] : []);
            // A first chart led by this team's own leader holds its members directly: remember the team.
            next = { leader: humanId ? { kind: "human", id: humanId } : { kind: "agent", id: rootId }, teamIds, nodes, ...(teamIds.includes(teamId) ? {} : { flatTeamIds: [teamId] }) };
        } else if (stored.nodes?.length) {
            const nodes = addTeamToChart(stored.nodes, team);
            if (nodes) next = { ...stored, nodes, teamIds: nodes.flatMap(n => n.kind === "team" ? [n.teamId] : []) };
        } else {
            // A chart saved before reporting trees: just list the team.
            next = { ...stored, teamIds: [...stored.teamIds, teamId] };
        }
        if (!next) return { changed: false, onChart: false, config: stored };
        await tx.update(companies).set({ organizationJson: next }).where(eq(companies.id, companyId));
        return { changed: true, onChart: placed(next), config: next };
    });
    if (result.changed) invalidateOrganizationCache(companyId);
    return result;
}
