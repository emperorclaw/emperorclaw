import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, companies, companyMembers, users } from "@/db/schema";
import { GroupError, listGroups, type GroupSummary } from "@/lib/groups";
import type { CoordinatorRef } from "@/lib/team-coordination";

export type OrganizationConfig = { leader: CoordinatorRef | null; teamIds: string[] };
export function parseOrganization(input: unknown): OrganizationConfig {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new GroupError("Invalid organization", 400);
    const value = input as Record<string, unknown>;
    const leader = value.leader;
    if (leader !== null && (!leader || typeof leader !== "object" || !["agent", "human"].includes((leader as CoordinatorRef).kind) || typeof (leader as CoordinatorRef).id !== "string")) throw new GroupError("Choose one company leader", 400);
    if (!Array.isArray(value.teamIds) || value.teamIds.length > 200 || value.teamIds.some(id => typeof id !== "string" || !id)) throw new GroupError("Invalid teams", 400);
    return { leader: leader ? { kind: (leader as CoordinatorRef).kind, id: (leader as CoordinatorRef).id } : null, teamIds: [...new Set(value.teamIds as string[])] };
}
export async function loadOrganization(companyId: string) {
    const [[company], roster, people, groups] = await Promise.all([
        db.select({ name: companies.name, config: companies.organizationJson }).from(companies).where(and(eq(companies.id, companyId), isNull(companies.deletedAt))),
        db.select({ id: agents.id, name: agents.name, role: agents.role, avatarUrl: agents.avatarUrl, avatarAppearance: agents.avatarAppearance, status: agents.status }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
        db.select({ id: users.id, name: users.displayName }).from(companyMembers).innerJoin(users, eq(companyMembers.userId, users.id)).where(and(eq(companyMembers.companyId, companyId), isNull(users.deletedAt))),
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
    const changed = await db.update(companies).set({ organizationJson: config }).where(initialize ? and(eq(companies.id, companyId), isNull(companies.organizationJson)) : eq(companies.id, companyId)).returning({id: companies.id});
    if (!changed.length) throw new GroupError("Organization is already configured", 409);
    return config;
}
/** A reporting relationship guides coordination; it never grants permission. */
export function organizationBriefing(leader: { kind: string; id: string; name: string } | null, teams: GroupSummary[], agentId: string) {
    const own = teams.filter(team => team.members.some(member => member.kind === "agent" && member.id === agentId));
    return { leader, teams: own.map(team => ({ id: team.id, name: team.title, purpose: team.description, coordinator: team.coordinator ? { kind: team.coordinator.kind, id: team.coordinator.id, name: team.coordinator.name } : null })), reportingRule: "For team work, report progress to that team's coordinator when assigned; otherwise to the company leader. For cross-team questions, consult the company leader. If you are the team coordinator, report to the company leader; if you are also the company leader, report to humans. Existing task ownership, approvals and access rules still apply. Send updates only when useful; do not start reporting loops." };
}
