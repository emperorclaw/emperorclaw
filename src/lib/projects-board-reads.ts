import { and, eq, inArray, isNull, or, sql, type AnyColumn } from "drizzle-orm";
import { db } from "@/db";
import { agents, artifacts, companyMembers, customers, projectMemory, projects, recurringTaskDefinitions, resourceMemberships, taskEvents, tasks, users } from "@/db/schema";
import { agentsNotUsableBy, usableAgentCondition } from "@/lib/agent-access-server";
import { memberAgentCondition, memberProjectCondition, memberRecordCondition } from "@/lib/member-scope";
import { projectsWithRole } from "@/lib/resource-access";
import { roleGte } from "@/lib/role-matrix";
import type { GuardContext } from "@/lib/roles";

type MemberRow = { id: string; userId: string; displayName: string | null; email: string; roleTitle: string | null; companyRole: string };

/**
 * The people the board names (assignee pickers, task cards). Admins: the whole
 * directory with emails. Everyone else: names only, never emails; an
 * unrestricted member still gets everyone (any project is theirs to staff), a
 * restricted one only the people on their visible projects/clients, the
 * people their visible tasks are assigned to, and themselves.
 */
async function boardMembers(viewer: GuardContext, rows: MemberRow[], visible: { projectIds: string[]; customerIds: string[]; assignedMemberIds: (string | null)[] }): Promise<(Omit<MemberRow, "email"> & { email: string | null })[]> {
    if (roleGte(viewer.role, "admin")) return rows;
    let keep: (row: MemberRow) => boolean = () => true;
    if (viewer.scope) {
        const conditions = [
            visible.projectIds.length ? and(eq(resourceMemberships.resourceType, "project"), inArray(resourceMemberships.resourceId, visible.projectIds)) : undefined,
            visible.customerIds.length ? and(eq(resourceMemberships.resourceType, "customer"), inArray(resourceMemberships.resourceId, visible.customerIds)) : undefined,
        ].filter(Boolean);
        const sharing = conditions.length
            ? new Set((await db.selectDistinct({ userId: resourceMemberships.userId }).from(resourceMemberships)
                .where(and(eq(resourceMemberships.companyId, viewer.companyId), or(...conditions)))).map((r) => r.userId))
            : new Set<string>();
        const assigned = new Set(visible.assignedMemberIds.filter(Boolean));
        keep = (row) => row.userId === viewer.userId || sharing.has(row.userId) || assigned.has(row.id);
    }
    return rows.filter(keep).map((row) => ({ ...row, displayName: row.displayName || "Unnamed member", email: null }));
}

/**
 * Everything the Projects board (/projects) shows, for one signed-in person:
 * only the projects in their member scope (their customers' and the ones
 * granted directly) and what hangs off them; agents in their scope that they
 * may use (0.20 "Who can use it"). Unrestricted members see the whole company,
 * exactly as before.
 *
 * `canEditAll` is true when the company role edits everywhere; otherwise
 * `editableProjectIds` lists the projects they hold "Can edit"/Admin on.
 */
export async function loadProjectsBoard(viewer: GuardContext) {
    const { companyId, scope } = viewer;
    const projectRows = await db.select().from(projects).where(and(
        eq(projects.companyId, companyId), isNull(projects.deletedAt),
        memberProjectCondition(scope, { id: projects.id, customerId: projects.customerId }),
    ));
    const projectIds = projectRows.map((p) => p.id);
    // Restricted with nothing visible: no project-bound rows at all.
    const inProjects = (column: AnyColumn) => scope ? (projectIds.length ? inArray(column, projectIds) : sql`false`) : undefined;
    const customerIds = [...new Set([...(scope?.customerIds ?? []), ...projectRows.map((p) => p.customerId).filter((id): id is string => Boolean(id))])];
    const { hidden, metadata } = await agentsNotUsableBy(viewer);

    const [taskRows, agentRows, customerRows, artifactRows, memoryRows, recurringRows, memberRows] = await Promise.all([
        db.select().from(tasks).where(and(eq(tasks.companyId, companyId), isNull(tasks.deletedAt), inProjects(tasks.projectId))),
        // Explicit, safe columns: never keys, doctrine, memory or scope.
        db.select({
            id: agents.id, name: agents.name, role: agents.role, avatarUrl: agents.avatarUrl, avatarAppearance: agents.avatarAppearance,
            status: agents.status, lastSeenAt: agents.lastSeenAt, provider: agents.provider, budgetStatus: agents.budgetStatus,
            currentLoad: agents.currentLoad, concurrencyLimit: agents.concurrencyLimit, createdAt: agents.createdAt,
        }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt),
            memberAgentCondition(scope, agents.id), usableAgentCondition(hidden, agents.id))),
        // A project's client name is shown on its card, so its customer comes along.
        db.select().from(customers).where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt),
            scope ? (customerIds.length ? inArray(customers.id, customerIds) : sql`false`) : undefined)),
        db.select().from(artifacts).leftJoin(projects, eq(projects.id, artifacts.projectId)).where(and(eq(artifacts.companyId, companyId), isNull(artifacts.deletedAt),
            memberRecordCondition(scope, { projectId: artifacts.projectId, customerId: artifacts.customerId, projectCustomerId: projects.customerId }))),
        db.select().from(projectMemory).where(and(eq(projectMemory.companyId, companyId), inProjects(projectMemory.projectId))),
        db.select().from(recurringTaskDefinitions).where(and(eq(recurringTaskDefinitions.companyId, companyId), isNull(recurringTaskDefinitions.deletedAt),
            scope ? (projectIds.length ? inArray(recurringTaskDefinitions.projectId, projectIds) : sql`false`) : undefined)),
        db.select({
            id: companyMembers.id,
            userId: users.id,
            displayName: users.displayName,
            email: users.email,
            roleTitle: users.roleTitle,
            companyRole: companyMembers.role,
        }).from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
            .where(and(eq(companyMembers.companyId, companyId), isNull(users.deletedAt))),
    ]);
    const taskIds = taskRows.map((t) => t.id);
    // Tasks held by an agent this person may not use: a tiny stand-in so the
    // card says who (name for owners/admins, who see it as metadata) or
    // "Private agent" (everyone else), never the agent itself.
    const heldIds = [...new Set(taskRows.map((t) => t.assignedAgentId).filter((id): id is string => Boolean(id) && hidden.has(id as string)))];
    const named = heldIds.some((id) => metadata.has(id))
        ? new Map((await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, heldIds.filter((id) => metadata.has(id)))))).map((a) => [a.id, a.name]))
        : new Map<string, string>();
    const limitedAgents = heldIds.map((id) => ({ id, name: named.get(id) ?? null, limited: true as const }));
    const members = await boardMembers(viewer, memberRows, { projectIds, customerIds, assignedMemberIds: taskRows.map((t) => t.assignedMemberId) });
    const eventRows = scope && taskIds.length === 0 ? [] : await db.select().from(taskEvents).where(and(
        eq(taskEvents.companyId, companyId), scope ? inArray(taskEvents.taskId, taskIds) : undefined,
    ));

    const canEditAll = roleGte(viewer.role, "member") && !scope;
    const editableProjectIds = canEditAll ? [] : [...await projectsWithRole(viewer, projectIds)];
    return {
        projects: projectRows,
        tasks: taskRows,
        agents: agentRows,
        limitedAgents,
        customers: customerRows,
        artifacts: artifactRows.map((row) => row.artifacts),
        taskEvents: eventRows,
        projectMemory: memoryRows,
        recurringDefinitions: recurringRows,
        members,
        canEditAll,
        editableProjectIds,
    };
}
