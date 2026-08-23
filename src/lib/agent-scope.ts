import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { agents, projects } from "@/db/schema";
import { and, eq, inArray, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { resolveAgentId } from "@/lib/mcp";

export type AgentScope = {
    mode?: "all" | "restricted";
    customerIds?: string[];
    projectIds?: string[];
};

export type AgentScopeContext = {
    scope: AgentScope | null;
    allowedProjectIds: Set<string> | null;
    allowedCustomerIds: Set<string> | null;
};

/** null = unrestricted (no scoping row, or mode isn't 'restricted'). */
export async function getAgentScope(companyId: string, agentId: string): Promise<AgentScope | null> {
    const [row] = await db.select({ scopeJson: agents.scopeJson }).from(agents).where(and(
        eq(agents.id, agentId),
        eq(agents.companyId, companyId),
        isNull(agents.deletedAt),
    )).limit(1);
    const scope = row?.scopeJson as AgentScope | undefined;
    if (!scope || scope.mode !== "restricted") return null;
    return scope;
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
        return { scope: null, allowedProjectIds: null, allowedCustomerIds: null };
    }
    const scope = await getAgentScope(companyId, resolvedAgentId);
    const [allowedProjectIds, allowedCustomerIds] = await Promise.all([
        getAllowedProjectIds(companyId, scope),
        getAllowedCustomerIds(companyId, scope),
    ]);
    return { scope, allowedProjectIds, allowedCustomerIds };
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
 * shape. Returns a NextResponse to return immediately (404 unknown agent, or 404
 * if the project isn't in that agent's scope), or null if the caller may proceed
 * (including when no agentId query param was supplied at all — unscoped callers).
 */
export async function requireProjectInScope(
    req: NextRequest,
    companyId: string,
    projectId: string,
): Promise<NextResponse | null> {
    const agentIdParam = req.nextUrl.searchParams.get("agentId");
    if (!agentIdParam) return null;
    let resolvedAgentId: string;
    try {
        resolvedAgentId = await resolveAgentId(companyId, agentIdParam);
    } catch {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    const { allowedProjectIds } = await loadAgentScopeContext(companyId, resolvedAgentId);
    if (!isProjectAllowed(allowedProjectIds, projectId)) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return null;
}
