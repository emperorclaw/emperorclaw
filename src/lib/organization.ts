import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, companies, companyMembers, users } from "@/db/schema";
import { GroupError, listGroups, type GroupSummary } from "@/lib/groups";
import { validateOrganizationTree, type OrganizationNode } from "@/lib/organization-tree";
import type { CoordinatorRef } from "@/lib/team-coordination";

export type OrganizationConfig = { leader: CoordinatorRef | null; teamIds: string[]; nodes?: OrganizationNode[] };
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
    const stored: OrganizationConfig = company.config ?? { leader: null, teamIds: [] };
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
    return config;
}
/** A reporting relationship guides coordination; it never grants permission. */
export function organizationBriefing(leader: { kind: string; id: string; name: string } | null, teams: GroupSummary[], agentId: string, nodes: OrganizationNode[] = [], names: {id: string; name: string; kind: "agent" | "human"}[] = []) {
    const own = teams.filter(team => team.members.some(member => member.kind === "agent" && member.id === agentId));
    const lookup = (kind: "agent" | "human", id: string) => names.find(p => p.kind === kind && p.id === id) ?? {kind,id,name:kind === "human" ? "Human executive" : "AI lead"};
    const reporting = nodes.filter(n => (n.kind === "person" && n.person.kind === "agent" && n.person.id === agentId) || (n.kind === "team" && n.leaderAgentId === agentId)).map(n => {
        const parent = nodes.find(p => p.id === n.parentId);
        const target = parent?.kind === "person" ? lookup(parent.person.kind,parent.person.id) : parent?.kind === "team" ? lookup("agent",parent.leaderAgentId) : null;
        let containing = parent;
        while (containing?.kind === "person") containing = nodes.find(p => p.id === containing!.parentId);
        const teamId = n.kind === "team" ? n.teamId : containing?.kind === "team" ? containing.teamId : null;
        return { nodeId:n.id, teamId, context:teamId ? teams.find(t => t.id === teamId)?.title ?? "Team" : "Direct reporting", reportsTo:target && !(target.kind === "agent" && target.id === agentId) ? target : null };
    });
    if (nodes.length) for (const team of own) {
        if (reporting.some(r => r.teamId === team.id)) continue;
        const node = nodes.find(n => n.kind === "team" && n.teamId === team.id);
        if (node?.kind === "team") reporting.push({nodeId:node.id,teamId:team.id,context:team.title,reportsTo:node.leaderAgentId === agentId ? leader && leader.id !== agentId ? {...leader,kind:leader.kind as "agent" | "human"} : null : lookup("agent",node.leaderAgentId)});
    }
    return { reporting, leader, teams: own.map(team => ({ id: team.id, name: team.title, purpose: team.description, coordinator: team.coordinator ? { kind: team.coordinator.kind, id: team.coordinator.id, name: team.coordinator.name } : null })), reportingRule: "An agent may collaborate in several teams. Use the task or conversation team to select its reporting relationship; do not treat every team leader as a manager for every task. Each task has one coordinating owner; joining a team never transfers task ownership. Report useful progress to that team leader; team leaders follow their chart reporting relationship. Escalate conflicting priorities or unclear ownership to the company leader, or to humans if you are that leader. Existing task ownership, approvals and access rules still apply. Send updates only when useful; do not start reporting loops." };
}
