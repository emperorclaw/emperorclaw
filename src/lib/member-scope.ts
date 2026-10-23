import { and, eq, inArray, isNull, or, type AnyColumn, type SQL } from "drizzle-orm";
import type { SessionWithUserId } from "@/lib/auth";

/**
 * A restricted member's access scope (company_members.scope_json), set by an
 * admin in Settings -> Members -> Access scope.
 *
 * Model: `mode: "restricted"` turns the scope on; `agentIds` and `customerIds`
 * are then two independent allow-lists. An EMPTY list grants NOTHING on that
 * axis (fail closed, the same rule agent scopes use): "restricted" with no
 * agents ticked means the member sees no agents, not every agent.
 *
 * Projects (and their tasks, approvals, files) follow their customer: a
 * restricted member sees a project only when its customer is allowed, so
 * internal projects without a customer are hidden too.
 *
 * Owners/admins are never scoped (roles.ts drops the scope for them).
 */
export type MemberScope = {
    agentIds?: string[];
    customerIds?: string[];
    mode?: "all" | "restricted";
};

function asIdList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

/** null = unrestricted. A restricted scope always carries both arrays. */
export function normalizeMemberScope(raw: unknown): MemberScope | null {
    if (!raw || typeof raw !== "object") return null;
    const scope = raw as MemberScope;
    if (scope.mode !== "restricted") return null;
    return { mode: "restricted", agentIds: asIdList(scope.agentIds), customerIds: asIdList(scope.customerIds) };
}

/**
 * The scope currently stored for a member. Reads the DB (not the login-time
 * JWT copy) so an admin's change applies on the next request.
 */
export async function loadMemberScope(userId: string, companyId?: string | null): Promise<MemberScope | null> {
    const { db } = await import("@/db");
    const { companyMembers, users } = await import("@/db/schema");
    const [row] = await db.select({ scopeJson: companyMembers.scopeJson, role: companyMembers.role, instanceRole: users.instanceRole })
        .from(companyMembers)
        .innerJoin(users, eq(users.id, companyMembers.userId))
        .where(companyId ? and(eq(companyMembers.userId, userId), eq(companyMembers.companyId, companyId)) : eq(companyMembers.userId, userId))
        .orderBy(companyMembers.createdAt)
        .limit(1);
    if (!row) return null;
    if (row.instanceRole === "instance_admin" || row.role === "owner" || row.role === "admin") return null;
    return normalizeMemberScope(row.scopeJson);
}

/** Server pages: the viewer's scope from the DB, keyed by their session. */
export async function getMemberScopeForSession(session: SessionWithUserId | null | undefined): Promise<MemberScope | null> {
    const userId = session?.user?.id;
    if (!userId) return null;
    return loadMemberScope(userId);
}

/**
 * @deprecated The JWT copy is stale after an admin edits the scope; use
 * getMemberScopeForSession / requireRole().scope instead.
 */
export function getScopeFromSession(session: SessionWithUserId): MemberScope | null {
    return normalizeMemberScope((session.user as { scopeJson?: unknown } | undefined)?.scopeJson);
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

export function memberMaySeeAgent(scope: MemberScope | null, agentId: string | null | undefined): boolean {
    if (!scope) return true;
    return Boolean(agentId) && (scope.agentIds ?? []).includes(agentId as string);
}

export function memberMaySeeCustomer(scope: MemberScope | null, customerId: string | null | undefined): boolean {
    if (!scope) return true;
    return Boolean(customerId) && (scope.customerIds ?? []).includes(customerId as string);
}

/** A project is visible through its customer. */
export function memberMaySeeProject(scope: MemberScope | null, project: { customerId: string | null | undefined } | null | undefined): boolean {
    if (!scope) return true;
    return Boolean(project) && memberMaySeeCustomer(scope, project!.customerId);
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

/** Ids of the projects a restricted member may see (via their customers); null = unrestricted. */
export async function memberVisibleProjectIds(companyId: string, scope: MemberScope | null): Promise<Set<string> | null> {
    if (!scope) return null;
    const customerIds = scope.customerIds ?? [];
    if (customerIds.length === 0) return new Set();
    const { db } = await import("@/db");
    const { projects } = await import("@/db/schema");
    const rows = await db.select({ id: projects.id }).from(projects)
        .where(and(eq(projects.companyId, companyId), inArray(projects.customerId, customerIds)));
    return new Set(rows.map((row) => row.id));
}

/** True when the project exists in this company and the member may see it. */
export async function memberMaySeeProjectId(companyId: string, scope: MemberScope | null, projectId: string | null | undefined): Promise<boolean> {
    if (!scope) return true;
    if (!projectId) return false;
    const visible = await memberVisibleProjectIds(companyId, scope);
    return Boolean(visible?.has(projectId));
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
 * pipelines): visible when their customer (direct or via the project) is in
 * scope; a record with neither is company-wide and visible to every member.
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
    return or(
        and(isNull(columns.projectId), isNull(columns.customerId)),
        inArray(columns.customerId, ids),
        columns.projectCustomerId ? inArray(columns.projectCustomerId, ids) : undefined,
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
        approvalIds.length ? db.select({ id: approvals.id, projectId: approvals.projectId }).from(approvals).where(and(eq(approvals.companyId, companyId), inArray(approvals.id, approvalIds))) : Promise.resolve([]),
        incidentIds.length ? db.select({ id: incidents.id, projectId: incidents.projectId }).from(incidents).where(and(eq(incidents.companyId, companyId), inArray(incidents.id, incidentIds))) : Promise.resolve([]),
        messageIds.length
            ? db.select({ id: threadMessages.id, senderType: threadMessages.senderType, senderId: threadMessages.senderId, targetAgentId: threadMessages.targetAgentId, directAgentId: messageThreads.directAgentId })
                .from(threadMessages).innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
                .where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.id, messageIds)))
            : Promise.resolve([]),
    ]);
    const projectOf = new Map<string, string>([...taskRows, ...approvalRows, ...incidentRows].map((r) => [r.id, r.projectId]));
    const messageAgents = new Map(messageRows.map((m) => [m.id,
        [m.directAgentId, m.targetAgentId, m.senderType === "agent" ? m.senderId : null].filter((id): id is string => Boolean(id))]));
    return rows.filter((row) => {
        if (!row.sourceType || !row.sourceId) return true;
        switch (row.sourceType) {
            case "agent": return memberMaySeeAgent(scope, row.sourceId);
            case "task":
            case "approval":
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
    const ids: string[] = [];
    if (typeof body.assignedAgentId === "string" && body.assignedAgentId) ids.push(body.assignedAgentId);
    const assignee = body.assignee as { type?: unknown; id?: unknown } | null | undefined;
    if (assignee && assignee.type === "agent" && typeof assignee.id === "string") ids.push(assignee.id);
    return ids.every((id) => memberMaySeeAgent(scope, id));
}
