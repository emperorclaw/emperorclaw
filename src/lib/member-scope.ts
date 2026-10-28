import { and, eq, inArray, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { SessionWithUserId } from "@/lib/auth";

/**
 * A restricted member's access scope, set by an admin in Settings -> Members
 * -> Access scope and in a client's or project's Access dialog.
 *
 * Model: `mode: "restricted"` (company_members.scope_json) turns the scope on;
 * `agentIds` (also scope_json) and the member's customers and projects are
 * then independent allow-lists. An EMPTY list grants NOTHING on that axis
 * (fail closed, the same rule agent scopes use): "restricted" with no agents
 * ticked means the member sees no agents, not every agent.
 *
 * Since 0.20 `customerIds` and `projectIds` come from resource_memberships
 * (lib/resource-roles.ts), never from scope_json. A project (and its tasks,
 * approvals, files, views, notes) is visible when its customer is in
 * customerIds OR the project itself is in projectIds, so internal projects
 * without a customer are hidden unless granted directly.
 *
 * Owners/admins are never scoped (roles.ts drops the scope for them).
 */
export type MemberScope = {
    agentIds?: string[];
    customerIds?: string[];
    projectIds?: string[];
    mode?: "all" | "restricted";
};

/** A resource_memberships row, reduced to what the scope needs. */
export type ScopeMembership = { resourceType: string; resourceId: string };

function asIdList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

/**
 * null = unrestricted. A restricted scope always carries all three arrays; the
 * customer and project lists come from the member's resource memberships (a
 * legacy scope_json.customerIds is ignored: migration 0072 moved it).
 */
export function normalizeMemberScope(raw: unknown, memberships: readonly ScopeMembership[] = []): MemberScope | null {
    if (!raw || typeof raw !== "object") return null;
    const scope = raw as MemberScope;
    if (scope.mode !== "restricted") return null;
    const ids = (type: string) => [...new Set(memberships.filter((m) => m.resourceType === type).map((m) => m.resourceId))];
    return { mode: "restricted", agentIds: asIdList(scope.agentIds), customerIds: ids("customer"), projectIds: ids("project") };
}

/** A member's resource memberships in one company (customer and project rows). */
export async function loadScopeMemberships(companyId: string, userId: string): Promise<{ resourceType: string; resourceId: string; role: string }[]> {
    const { db } = await import("@/db");
    const { resourceMemberships } = await import("@/db/schema");
    return db.select({ resourceType: resourceMemberships.resourceType, resourceId: resourceMemberships.resourceId, role: resourceMemberships.role })
        .from(resourceMemberships)
        .where(and(eq(resourceMemberships.companyId, companyId), eq(resourceMemberships.userId, userId)));
}

/**
 * A member's scope from their stored scope_json plus their memberships. Only
 * a restricted scope needs the memberships, so unrestricted members cost no
 * extra query.
 */
export async function resolveMemberScope(companyId: string, userId: string, scopeJson: unknown): Promise<MemberScope | null> {
    if (!normalizeMemberScope(scopeJson)) return null;
    return normalizeMemberScope(scopeJson, await loadScopeMemberships(companyId, userId));
}

/**
 * The scope currently stored for a member. Reads the DB (not the login-time
 * JWT copy) so an admin's change applies on the next request.
 */
export async function loadMemberScope(userId: string, companyId?: string | null): Promise<MemberScope | null> {
    const { db } = await import("@/db");
    const { companyMembers, users } = await import("@/db/schema");
    const [row] = await db.select({ scopeJson: companyMembers.scopeJson, role: companyMembers.role, instanceRole: users.instanceRole, companyId: companyMembers.companyId })
        .from(companyMembers)
        .innerJoin(users, eq(users.id, companyMembers.userId))
        .where(companyId ? and(eq(companyMembers.userId, userId), eq(companyMembers.companyId, companyId)) : eq(companyMembers.userId, userId))
        .orderBy(companyMembers.createdAt)
        .limit(1);
    if (!row) return null;
    if (row.instanceRole === "instance_admin" || row.role === "owner" || row.role === "admin") return null;
    return resolveMemberScope(row.companyId, userId, row.scopeJson);
}

/** Server pages: the viewer's scope from the DB, keyed by their session. */
export async function getMemberScopeForSession(session: SessionWithUserId | null | undefined): Promise<MemberScope | null> {
    const userId = session?.user?.id;
    if (!userId) return null;
    return loadMemberScope(userId);
}

/** Apply a scope allow-list in memory (undefined = unrestricted). */
export function filterByScope<T extends { id: string }>(
    items: T[],
    allowedIds: string[] | undefined,
): T[] {
    if (!allowedIds) return items;
    const set = new Set(allowedIds);
    return items.filter(item => set.has(item.id));
}

/** Allowed agent ids, or undefined when unrestricted. [] = none. */
export function getScopedAgentIds(scope: MemberScope | null): string[] | undefined {
    if (!scope) return undefined;
    return scope.agentIds ?? [];
}

/** Allowed customer ids, or undefined when unrestricted. [] = none. */
export function getScopedCustomerIds(scope: MemberScope | null): string[] | undefined {
    if (!scope) return undefined;
    return scope.customerIds ?? [];
}

/** Projects granted directly (project memberships), or undefined when unrestricted. [] = none. */
export function getScopedProjectIds(scope: MemberScope | null): string[] | undefined {
    if (!scope) return undefined;
    return scope.projectIds ?? [];
}

export function memberMaySeeAgent(scope: MemberScope | null, agentId: string | null | undefined): boolean {
    if (!scope) return true;
    return Boolean(agentId) && (scope.agentIds ?? []).includes(agentId as string);
}

export function memberMaySeeCustomer(scope: MemberScope | null, customerId: string | null | undefined): boolean {
    if (!scope) return true;
    return Boolean(customerId) && (scope.customerIds ?? []).includes(customerId as string);
}

/** A project is visible through its customer or its own membership. */
export function memberMaySeeProject(scope: MemberScope | null, project: { id?: string | null; customerId: string | null | undefined } | null | undefined): boolean {
    if (!scope) return true;
    if (!project) return false;
    return memberMaySeeCustomer(scope, project.customerId)
        || (Boolean(project.id) && (scope.projectIds ?? []).includes(project.id as string));
}

/** SQL filter on an agent-id column (undefined = no filter). */
export function memberAgentCondition(scope: MemberScope | null, column: AnyColumn): SQL | undefined {
    const ids = getScopedAgentIds(scope);
    return ids ? inArray(column, ids) : undefined;
}

/** SQL filter on a customer-id column (undefined = no filter). */
export function memberCustomerCondition(scope: MemberScope | null, column: AnyColumn): SQL | undefined {
    const ids = getScopedCustomerIds(scope);
    return ids ? inArray(column, ids) : undefined;
}

/**
 * SQL filter on a project: its customer is granted or the project itself is
 * (undefined = no filter). `customerId` is the project's customer column.
 */
export function memberProjectCondition(scope: MemberScope | null, columns: { id: AnyColumn; customerId: AnyColumn }): SQL | undefined {
    if (!scope) return undefined;
    const customerIds = scope.customerIds ?? [];
    const projectIds = scope.projectIds ?? [];
    if (customerIds.length === 0 && projectIds.length === 0) return sql`false`;
    return or(
        customerIds.length ? inArray(columns.customerId, customerIds) : undefined,
        projectIds.length ? inArray(columns.id, projectIds) : undefined,
    );
}

/** Ids of the projects a restricted member may see (via their customers or a project membership); null = unrestricted. */
export async function memberVisibleProjectIds(companyId: string, scope: MemberScope | null): Promise<Set<string> | null> {
    if (!scope) return null;
    if ((scope.customerIds ?? []).length === 0 && (scope.projectIds ?? []).length === 0) return new Set();
    const { db } = await import("@/db");
    const { projects } = await import("@/db/schema");
    const rows = await db.select({ id: projects.id }).from(projects)
        .where(and(eq(projects.companyId, companyId), memberProjectCondition(scope, { id: projects.id, customerId: projects.customerId })));
    return new Set(rows.map((row) => row.id));
}

/** True when the project exists in this company and the member may see it. */
export async function memberMaySeeProjectId(companyId: string, scope: MemberScope | null, projectId: string | null | undefined): Promise<boolean> {
    if (!scope) return true;
    if (!projectId) return false;
    const visible = await memberVisibleProjectIds(companyId, scope);
    return Boolean(visible?.has(projectId));
}

/**
 * An approval is visible through its project; an agent's ask-first action
 * (no project) through the agent that asked.
 */
export function memberMaySeeApproval(scope: MemberScope | null, visibleProjects: Set<string> | null, approval: { projectId: string | null; requesterAgentId: string | null }): boolean {
    if (!scope) return true;
    if (approval.projectId) return Boolean(visibleProjects?.has(approval.projectId));
    return memberMaySeeAgent(scope, approval.requesterAgentId);
}

/** True when the task's project is visible to the member. */
export async function memberMaySeeTaskId(companyId: string, scope: MemberScope | null, taskId: string | null | undefined): Promise<boolean> {
    if (!scope) return true;
    if (!taskId) return false;
    const { db } = await import("@/db");
    const { tasks } = await import("@/db/schema");
    const [row] = await db.select({ projectId: tasks.projectId }).from(tasks)
        .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId))).limit(1);
    return Boolean(row) && memberMaySeeProjectId(companyId, scope, row.projectId);
}

/**
 * Records that may hang off a project and/or customer (artifacts, folders,
 * pipelines): visible when their customer (direct or via the project) or
 * their project is in scope; a record with neither is company-wide and
 * visible to every member.
 */
export async function memberMaySeeRecord(
    companyId: string,
    scope: MemberScope | null,
    record: { projectId?: string | null; customerId?: string | null } | null | undefined,
): Promise<boolean> {
    if (!scope) return true;
    if (!record) return false;
    if (!record.projectId && !record.customerId) return true;
    if (record.customerId && memberMaySeeCustomer(scope, record.customerId)) return true;
    return Boolean(record.projectId) && memberMaySeeProjectId(companyId, scope, record.projectId);
}

/** SQL twin of memberMaySeeRecord (undefined = no filter). Pass the joined projects.customerId when available. */
export function memberRecordCondition(
    scope: MemberScope | null,
    columns: { projectId: AnyColumn; customerId: AnyColumn; projectCustomerId?: AnyColumn },
): SQL | undefined {
    const ids = getScopedCustomerIds(scope);
    if (!ids) return undefined;
    const projectIds = getScopedProjectIds(scope) ?? [];
    return or(
        and(isNull(columns.projectId), isNull(columns.customerId)),
        ids.length ? inArray(columns.customerId, ids) : undefined,
        columns.projectCustomerId && ids.length ? inArray(columns.projectCustomerId, ids) : undefined,
        projectIds.length ? inArray(columns.projectId, projectIds) : undefined,
    );
}

/** Knowledge & Rules notes / scoped resources follow the scope they belong to. */
export async function memberMaySeeResource(
    companyId: string,
    scope: MemberScope | null,
    resource: { scopeType: string | null; scopeId: string | null } | null | undefined,
): Promise<boolean> {
    if (!scope) return true;
    if (!resource) return false;
    switch (resource.scopeType) {
        case "customer": return memberMaySeeCustomer(scope, resource.scopeId);
        case "project": return memberMaySeeProjectId(companyId, scope, resource.scopeId);
        case "agent": return memberMaySeeAgent(scope, resource.scopeId);
        default: return true;
    }
}

/** In-memory filter for resource lists (one project lookup for the whole list). */
export async function filterResourcesForMember<T extends { scopeType: string | null; scopeId: string | null }>(
    companyId: string,
    scope: MemberScope | null,
    rows: T[],
): Promise<T[]> {
    if (!scope) return rows;
    const projectsVisible = await memberVisibleProjectIds(companyId, scope);
    return rows.filter((row) => {
        switch (row.scopeType) {
            case "customer": return memberMaySeeCustomer(scope, row.scopeId);
            case "project": return Boolean(row.scopeId && projectsVisible?.has(row.scopeId));
            case "agent": return memberMaySeeAgent(scope, row.scopeId);
            default: return true;
        }
    });
}

/**
 * A person's notifications point at an agent, task, approval, incident or
 * message. A restricted member keeps only those whose source is inside their
 * scope (company-level notices without a source stay).
 */
export async function filterNotificationsForMember<T extends { sourceType: string | null; sourceId: string | null }>(
    companyId: string,
    scope: MemberScope | null,
    rows: T[],
): Promise<T[]> {
    if (!scope) return rows;
    const { db } = await import("@/db");
    const { approvals, incidents, tasks, threadMessages, messageThreads } = await import("@/db/schema");
    const visibleProjects = (await memberVisibleProjectIds(companyId, scope)) ?? new Set<string>();
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = (type: string) => rows.filter((r) => r.sourceType === type && r.sourceId && UUID.test(r.sourceId)).map((r) => r.sourceId as string);
    const taskIds = ids("task");
    const approvalIds = ids("approval");
    const incidentIds = ids("incident");
    const messageIds = ids("message");
    const [taskRows, approvalRows, incidentRows, messageRows] = await Promise.all([
        taskIds.length ? db.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.id, taskIds))) : Promise.resolve([]),
        approvalIds.length ? db.select({ id: approvals.id, projectId: approvals.projectId, requesterAgentId: approvals.requesterAgentId }).from(approvals).where(and(eq(approvals.companyId, companyId), inArray(approvals.id, approvalIds))) : Promise.resolve([]),
        incidentIds.length ? db.select({ id: incidents.id, projectId: incidents.projectId }).from(incidents).where(and(eq(incidents.companyId, companyId), inArray(incidents.id, incidentIds))) : Promise.resolve([]),
        messageIds.length
            ? db.select({ id: threadMessages.id, senderType: threadMessages.senderType, senderId: threadMessages.senderId, targetAgentId: threadMessages.targetAgentId, directAgentId: messageThreads.directAgentId })
                .from(threadMessages).innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
                .where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.id, messageIds)))
            : Promise.resolve([]),
    ]);
    const projectOf = new Map<string, string | null>([...taskRows, ...approvalRows, ...incidentRows].map((r) => [r.id, r.projectId]));
    const approvalById = new Map(approvalRows.map((r) => [r.id, r]));
    const messageAgents = new Map(messageRows.map((m) => [m.id,
        [m.directAgentId, m.targetAgentId, m.senderType === "agent" ? m.senderId : null].filter((id): id is string => Boolean(id))]));
    return rows.filter((row) => {
        if (!row.sourceType || !row.sourceId) return true;
        switch (row.sourceType) {
            case "agent": return memberMaySeeAgent(scope, row.sourceId);
            case "approval": {
                const approval = approvalById.get(row.sourceId);
                return approval ? memberMaySeeApproval(scope, visibleProjects, approval) : false;
            }
            case "task":
            case "incident": return visibleProjects.has(projectOf.get(row.sourceId) ?? "");
            case "message": return (messageAgents.get(row.sourceId) ?? []).every((id) => memberMaySeeAgent(scope, id));
            default: return true;
        }
    });
}

/**
 * Agents a request would assign work to (`assignedAgentId`, or an agent
 * `assignee`); a restricted member may only hand work to agents in scope.
 */
export function memberMayAssignAgents(scope: MemberScope | null, body: { assignedAgentId?: unknown; assignee?: unknown }): boolean {
    if (!scope) return true;
    return assignedAgentIds(body).every((id) => memberMaySeeAgent(scope, id));
}

/** The agent ids a create/update body would hand work to. */
export function assignedAgentIds(body: { assignedAgentId?: unknown; assignee?: unknown }): string[] {
    const ids: string[] = [];
    if (typeof body.assignedAgentId === "string" && body.assignedAgentId) ids.push(body.assignedAgentId);
    const assignee = body.assignee as { type?: unknown; id?: unknown } | null | undefined;
    if (assignee && assignee.type === "agent" && typeof assignee.id === "string") ids.push(assignee.id);
    return ids;
}
