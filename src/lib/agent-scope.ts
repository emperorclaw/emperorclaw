// Type-only: server.ts loads this module before Next starts, and a runtime
// import of next/server there crashes the boot (AsyncLocalStorage invariant).
import type { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { agents, projects } from "@/db/schema";
import { and, eq, inArray, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";

export type AgentScope = {
    mode?: "all" | "restricted";
    customerIds?: string[];
    projectIds?: string[];
    /**
     * Agents this agent may see in the roster, message and hand work to.
     * Independent of `mode` (which governs customers/projects). Absent = all
     * agents (the default); [] = none but itself. ONE-WAY: it limits only what
     * this agent reaches; the agents on the other side are unaffected.
     */
    agentIds?: string[];
};

export type AgentScopeContext = {
    scope: AgentScope | null;
    allowedProjectIds: Set<string> | null;
    allowedCustomerIds: Set<string> | null;
    /** Agents it may reach, always including itself; null = all agents. */
    allowedAgentIds: Set<string> | null;
};

/** The agent allow-list stored on an agent (always containing itself), or null for "all agents". */
export function agentAllowListFrom(scopeJson: unknown, selfId: string): Set<string> | null {
    const raw = scopeJson && typeof scopeJson === "object" ? (scopeJson as AgentScope).agentIds : undefined;
    if (!Array.isArray(raw)) return null;
    const allowed = new Set(raw.filter((id): id is string => typeof id === "string" && id.length > 0));
    allowed.add(selfId);
    return allowed;
}

/** null set = all agents. */
export function isAgentAllowed(allowedAgentIds: ReadonlySet<string> | null, agentId: string | null | undefined): boolean {
    if (allowedAgentIds === null) return true;
    return Boolean(agentId) && allowedAgentIds.has(agentId as string);
}

/**
 * The owner's member scope as a ceiling for an 'owner' agent (0.20): null =
 * no ceiling (the owner is unrestricted, an admin or the owner), "none" = the
 * owner is gone or no longer a member (fail closed: the agent sees nothing).
 * Read on every call, so an owner's scope change applies on the next request.
 */
async function ownerCeiling(companyId: string, ownerUserId: string | null): Promise<import("@/lib/member-scope").MemberScope | null | "none"> {
    if (!ownerUserId) return "none";
    const { companyMembers, users } = await import("@/db/schema");
    const { resolveMemberScope } = await import("@/lib/member-scope");
    const [row] = await db.select({ role: companyMembers.role, scopeJson: companyMembers.scopeJson, instanceRole: users.instanceRole })
        .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
        .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, ownerUserId), isNull(users.deletedAt))).limit(1);
    if (!row) return "none";
    if (row.instanceRole === "instance_admin" || row.role === "owner" || row.role === "admin") return null;
    return resolveMemberScope(companyId, ownerUserId, row.scopeJson);
}

/**
 * The scope an agent actually works with. For an agent whose access is
 * 'owner' (lib/agent-access.ts) it is its own scope intersected with its
 * owner's member scope: such an agent never sees more data than its owner.
 * Everyone else's agents: the stored scope, unchanged. `raw` keeps agentIds
 * whatever the mode (it is independent of the customer/project mode).
 */
export async function effectiveAgentScope(
    companyId: string,
    row: { scopeJson: unknown; access?: string | null; ownerUserId?: string | null } | undefined,
): Promise<{ scope: AgentScope | null; raw: AgentScope | undefined }> {
    const raw = row?.scopeJson && typeof row.scopeJson === "object" ? row.scopeJson as AgentScope : undefined;
    const scope = raw && raw.mode === "restricted" ? raw : null;
    if (!row || row.access !== "owner") return { scope, raw };
    const ceiling = await ownerCeiling(companyId, row.ownerUserId ?? null);
    if (ceiling === null) return { scope, raw };
    if (ceiling === "none") {
        const none: AgentScope = { mode: "restricted", customerIds: [], projectIds: [], agentIds: [] };
        return { scope: none, raw: none };
    }
    const { memberVisibleProjectIds } = await import("@/lib/member-scope");
    const [ownerProjects, agentProjects] = await Promise.all([
        memberVisibleProjectIds(companyId, ceiling),
        getAllowedProjectIds(companyId, scope),
    ]);
    const owned = ownerProjects ?? new Set<string>();
    const ownerCustomers = new Set(ceiling.customerIds ?? []);
    const ownerAgents = new Set(ceiling.agentIds ?? []);
    const projectIds = agentProjects ? [...agentProjects].filter((id) => owned.has(id)) : [...owned];
    const customerIds = scope ? (scope.customerIds ?? []).filter((id) => ownerCustomers.has(id)) : [...ownerCustomers];
    const agentIds = Array.isArray(raw?.agentIds) ? raw.agentIds.filter((id) => ownerAgents.has(id)) : [...ownerAgents];
    const capped: AgentScope = { mode: "restricted", customerIds, projectIds, agentIds };
    return { scope: capped, raw: capped };
}

/** null = unrestricted (no scoping row, or mode isn't 'restricted'). Includes the owner ceiling (effectiveAgentScope). */
export async function getAgentScope(companyId: string, agentId: string): Promise<AgentScope | null> {
    const [row] = await db.select({ scopeJson: agents.scopeJson, access: agents.access, ownerUserId: agents.ownerUserId }).from(agents).where(and(
        eq(agents.id, agentId),
        eq(agents.companyId, companyId),
        isNull(agents.deletedAt),
    )).limit(1);
    return (await effectiveAgentScope(companyId, row)).scope;
}

/**
 * Expand a scope into the concrete set of project ids it grants — the union of
 * scope.projectIds and every project under scope.customerIds. Returns null for
 * an unrestricted scope (caller should skip filtering entirely).
 */
export async function getAllowedProjectIds(companyId: string, scope: AgentScope | null): Promise<Set<string> | null> {
    if (!scope) return null;
    const explicitIds = scope.projectIds ?? [];
    const customerIds = scope.customerIds ?? [];
    const allowed = new Set(explicitIds);
    if (customerIds.length > 0) {
        const rows = await db.select({ id: projects.id }).from(projects).where(and(
            eq(projects.companyId, companyId),
            isNull(projects.deletedAt),
            inArray(projects.customerId, customerIds),
        ));
        for (const row of rows) allowed.add(row.id);
    }
    return allowed;
}

/**
 * Expand a scope into the concrete set of customer ids it grants — scope.customerIds
 * directly, plus the parent customer of every project in scope.projectIds (a
 * project-scoped agent still needs to see that project's own customer record).
 * Returns null for an unrestricted scope.
 */
export async function getAllowedCustomerIds(companyId: string, scope: AgentScope | null): Promise<Set<string> | null> {
    if (!scope) return null;
    const allowed = new Set(scope.customerIds ?? []);
    const projectIds = scope.projectIds ?? [];
    if (projectIds.length > 0) {
        const rows = await db.select({ customerId: projects.customerId }).from(projects).where(and(
            eq(projects.companyId, companyId),
            isNull(projects.deletedAt),
            inArray(projects.id, projectIds),
        ));
        for (const row of rows) {
            if (row.customerId) allowed.add(row.customerId);
        }
    }
    return allowed;
}

/** One call per request: resolves scope + both expanded allow-sets together. */
export async function loadAgentScopeContext(companyId: string, resolvedAgentId: string | null): Promise<AgentScopeContext> {
    if (!resolvedAgentId) {
        return { scope: null, allowedProjectIds: null, allowedCustomerIds: null, allowedAgentIds: null };
    }
    const [row] = await db.select({ scopeJson: agents.scopeJson, access: agents.access, ownerUserId: agents.ownerUserId }).from(agents).where(and(
        eq(agents.id, resolvedAgentId), eq(agents.companyId, companyId), isNull(agents.deletedAt),
    )).limit(1);
    const { scope, raw } = await effectiveAgentScope(companyId, row);
    const [allowedProjectIds, allowedCustomerIds] = await Promise.all([
        getAllowedProjectIds(companyId, scope),
        getAllowedCustomerIds(companyId, scope),
    ]);
    return { scope, allowedProjectIds, allowedCustomerIds, allowedAgentIds: agentAllowListFrom(raw, resolvedAgentId) };
}

/** null set = unrestricted (always allowed). Empty set = nothing is allowed. */
export function isProjectAllowed(allowedProjectIds: Set<string> | null, projectId: string | null | undefined): boolean {
    if (allowedProjectIds === null) return true;
    if (!projectId) return false;
    return allowedProjectIds.has(projectId);
}

export function isCustomerAllowed(allowedCustomerIds: Set<string> | null, customerId: string | null | undefined): boolean {
    if (allowedCustomerIds === null) return true;
    if (!customerId) return false;
    return allowedCustomerIds.has(customerId);
}

/**
 * Drizzle SQL condition for list queries. Returns undefined for an unrestricted
 * scope (append nothing). For an empty allow-set, returns sql`false` rather than
 * inArray(col, []) — an empty array to inArray() isn't guaranteed valid SQL across
 * pg driver versions, and "restricted with nothing granted" must match zero rows.
 */
export function scopeCondition(allowedIds: Set<string> | null, column: AnyColumn): SQL | undefined {
    if (allowedIds === null) return undefined;
    if (allowedIds.size === 0) return sql`false`;
    return inArray(column, [...allowedIds]);
}

/**
 * Route guard for the common "single project by path param, ?agentId= in query"
 * shape. The acting agent comes from the token binding (lib/mcp-access.ts), so
 * a bound token is scoped even when it names no agent. Returns a NextResponse
 * to return immediately (403/404), or null if the caller may proceed.
 */
export async function requireProjectInScope(
    req: NextRequest,
    companyId: string,
    projectId: string,
    token: { agentId?: string | null } | null | undefined,
): Promise<NextResponse | null> {
    const { mcpRouteAccess, mcpMayUseProject } = await import("@/lib/mcp-access");
    const { NextResponse } = await import("next/server");
    const scoped = await mcpRouteAccess(companyId, token, req.nextUrl.searchParams.get("agentId"));
    if (scoped.response) return scoped.response;
    if (!mcpMayUseProject(scoped.access, projectId)) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return null;
}
