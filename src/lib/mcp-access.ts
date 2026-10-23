import { NextResponse } from "next/server";
import { and, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { projects, tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { resolveAgentId } from "@/lib/mcp";
import { isCustomerAllowed, isProjectAllowed, loadAgentScopeContext, scopeCondition } from "@/lib/agent-scope";
import { canAgentReadResource } from "@/lib/resources";

/**
 * The single agent-facing access rule for /api/mcp/* routes and MCP tools.
 *
 * Who the caller acts as is decided by the TOKEN, never by the request alone:
 * - a token bound to an agent always acts as that agent; naming any other
 *   agent is refused (403), and omitting the agent still applies the bound
 *   agent's scope;
 * - a company-wide (operator) token acts as the agent it names, with that
 *   agent's scope, or unrestricted when it names none.
 *
 * The scope itself is the agent's `scopeJson` (customers + projects; see
 * lib/agent-scope.ts). Every check below reads the resolved access, so a route
 * cannot accidentally fall back to "the caller did not say who it is".
 */
export type McpAgentAccess = {
    /** The agent the request acts as; null for an operator token naming none. */
    agentId: string | null;
    /** True when the token itself is bound to `agentId`. */
    bound: boolean;
    allowedProjectIds: Set<string> | null;
    allowedCustomerIds: Set<string> | null;
};

export const UNRESTRICTED_MCP_ACCESS: McpAgentAccess = Object.freeze({
    agentId: null,
    bound: false,
    allowedProjectIds: null,
    allowedCustomerIds: null,
}) as McpAgentAccess;

export class McpAccessError extends Error {
    readonly status: 403 | 404;
    constructor(message: string, status: 403 | 404) {
        super(message);
        this.name = "McpAccessError";
        this.status = status;
    }
}

export const BOUND_AGENT_MISMATCH = "Access denied: this token is bound to a different agent";

/**
 * Resolve the acting agent and its scope for one request. Throws
 * McpAccessError (403 when a bound token names another agent, 404 for an
 * unknown agent).
 */
export async function resolveMcpAgentAccess(
    companyId: string,
    token: { agentId?: string | null } | null | undefined,
    requestedAgentId?: unknown,
): Promise<McpAgentAccess> {
    const bound = token?.agentId || null;
    const requested = typeof requestedAgentId === "string" && requestedAgentId.trim() ? requestedAgentId.trim() : null;
    let agentId = bound;
    if (requested) {
        let resolved: string;
        try {
            resolved = await resolveAgentId(companyId, requested);
        } catch {
            throw new McpAccessError(bound ? BOUND_AGENT_MISMATCH : `Agent not found: ${requested}`, bound ? 403 : 404);
        }
        if (bound && resolved !== bound) throw new McpAccessError(BOUND_AGENT_MISMATCH, 403);
        agentId = resolved;
    }
    if (!agentId) return { ...UNRESTRICTED_MCP_ACCESS };
    if (bound && !requested) {
        // Fail closed: a token still bound to a deleted agent has no scope row,
        // which would otherwise read as "unrestricted".
        try {
            await resolveAgentId(companyId, bound);
        } catch {
            throw new McpAccessError("Access denied: this token's agent no longer exists", 403);
        }
    }
    const { allowedProjectIds, allowedCustomerIds } = await loadAgentScopeContext(companyId, agentId);
    return { agentId, bound: Boolean(bound), allowedProjectIds, allowedCustomerIds };
}

/** Access for a caller whose agent is already known (e.g. an MCP tool session bound to an agent). */
export async function mcpAccessForAgent(companyId: string, agentId: string | null | undefined): Promise<McpAgentAccess> {
    return resolveMcpAgentAccess(companyId, { agentId: agentId ?? null });
}

export function isMcpAccessRestricted(access: McpAgentAccess): boolean {
    return access.allowedProjectIds !== null || access.allowedCustomerIds !== null;
}

export function mcpMayUseProject(access: McpAgentAccess, projectId: string | null | undefined): boolean {
    return isProjectAllowed(access.allowedProjectIds, projectId);
}

export function mcpMayUseCustomer(access: McpAgentAccess, customerId: string | null | undefined): boolean {
    return isCustomerAllowed(access.allowedCustomerIds, customerId);
}

/**
 * A record that may belong to a project and/or customer (artifact, folder,
 * thread, run...). One with neither is company-wide and visible to every
 * agent, the same exemption team chat and company knowledge get.
 */
export function mcpMayUseRecord(
    access: McpAgentAccess,
    record: { projectId?: string | null; customerId?: string | null },
): boolean {
    if (!isMcpAccessRestricted(access)) return true;
    if (!record.projectId && !record.customerId) return true;
    return (record.projectId ? mcpMayUseProject(access, record.projectId) : false)
        || (record.customerId ? mcpMayUseCustomer(access, record.customerId) : false);
}

/**
 * Knowledge / scoped resources: the same rule the knowledge index and context
 * builders use (company notes, the agent's own notes, and notes of projects or
 * customers in scope). An operator token naming no agent sees everything.
 */
export function mcpMayUseResource(access: McpAgentAccess, resource: { scopeType: string; scopeId: string | null }): boolean {
    if (!access.agentId) return true;
    return canAgentReadResource(resource, {
        callerAgentId: access.agentId,
        allowedProjectIds: access.allowedProjectIds,
        allowedCustomerIds: access.allowedCustomerIds,
    });
}

/**
 * Writing a scoped note/resource: only into projects/customers in scope, and a
 * bound agent only into its own private agent scope. Company scope is open.
 */
export function mcpMayWriteResourceScope(access: McpAgentAccess, scopeType: string | null | undefined, scopeId: string | null | undefined): boolean {
    if (scopeType === "project") return mcpMayUseProject(access, scopeId);
    if (scopeType === "customer") return mcpMayUseCustomer(access, scopeId);
    if (scopeType === "agent") return !access.bound || scopeId === access.agentId;
    return true;
}

/** SQL twin of mcpMayUseProject for list queries (undefined = no filter). */
export function mcpProjectCondition(access: McpAgentAccess, column: AnyColumn): SQL | undefined {
    return scopeCondition(access.allowedProjectIds, column);
}

/** SQL twin of mcpMayUseCustomer for list queries (undefined = no filter). */
export function mcpCustomerCondition(access: McpAgentAccess, column: AnyColumn): SQL | undefined {
    return scopeCondition(access.allowedCustomerIds, column);
}

/** SQL twin of mcpMayUseRecord (undefined = no filter). */
export function mcpRecordCondition(
    access: McpAgentAccess,
    columns: { projectId?: AnyColumn; customerId?: AnyColumn },
): SQL | undefined {
    if (!isMcpAccessRestricted(access)) return undefined;
    const companyWide = and(
        columns.projectId ? isNull(columns.projectId) : undefined,
        columns.customerId ? isNull(columns.customerId) : undefined,
    );
    const parts: (SQL | undefined)[] = [companyWide];
    if (columns.projectId) parts.push(scopeCondition(access.allowedProjectIds ?? new Set(), columns.projectId));
    if (columns.customerId) parts.push(scopeCondition(access.allowedCustomerIds ?? new Set(), columns.customerId));
    return or(...parts) ?? sql`false`;
}

/** True when the task exists in this company and its project is in scope. Missing tasks pass (callers 404 them). */
export async function mcpMayUseTask(companyId: string, access: McpAgentAccess, taskId: string | null | undefined): Promise<boolean> {
    if (!taskId || !isMcpAccessRestricted(access)) return true;
    const [row] = await db.select({ projectId: tasks.projectId }).from(tasks)
        .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId))).limit(1);
    return !row || mcpMayUseProject(access, row.projectId);
}

/** Customer of a project, for project-scoped checks that also accept customer grants. */
export async function projectCustomerId(companyId: string, projectId: string): Promise<string | null> {
    const [row] = await db.select({ customerId: projects.customerId }).from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId))).limit(1);
    return row?.customerId ?? null;
}

/**
 * Thread visibility: a thread tied to a project or task is visible only when
 * that project is in scope. Team, direct and group threads carry no project
 * and are governed by their own membership rules (lib/thread-access.ts).
 */
export async function mcpMayUseThread(
    companyId: string,
    access: McpAgentAccess,
    thread: { projectId?: string | null; taskId?: string | null },
): Promise<boolean> {
    if (!isMcpAccessRestricted(access)) return true;
    if (thread.projectId && !mcpMayUseProject(access, thread.projectId)) return false;
    if (thread.taskId && !(await mcpMayUseTask(companyId, access, thread.taskId))) return false;
    return true;
}

/**
 * SQL predicate on a thread-id column: hide threads tied to an out-of-scope
 * project or task. undefined = no filter.
 */
export function mcpThreadIdCondition(companyId: string, access: McpAgentAccess, threadIdColumn: AnyColumn): SQL | undefined {
    if (!isMcpAccessRestricted(access)) return undefined;
    const allowed = [...(access.allowedProjectIds ?? new Set<string>())];
    const allowedArray = allowed.length > 0
        ? sql`ARRAY[${sql.join(allowed.map((id) => sql`${id}::uuid`), sql`, `)}]`
        : sql`ARRAY[]::uuid[]`;
    return sql`${threadIdColumn} NOT IN (
        SELECT mt.id FROM message_threads mt
            LEFT JOIN tasks t ON t.id = mt.task_id
        WHERE mt.company_id = ${companyId}::uuid
          AND (
            (mt.project_id IS NOT NULL AND NOT (mt.project_id = ANY(${allowedArray})))
            OR (t.project_id IS NOT NULL AND NOT (t.project_id = ANY(${allowedArray})))
          )
    )`;
}

/**
 * Agent-private operations (its sessions/memory, integrations, deletion): a
 * bound token may only perform them on its own agent record. Operator
 * tokens may act on any agent.
 */
export async function mcpTokenMayActOnAgent(
    companyId: string,
    token: { agentId?: string | null } | null | undefined,
    agentRef: string,
): Promise<boolean> {
    const bound = token?.agentId || null;
    if (!bound) return true;
    try {
        return (await resolveAgentId(companyId, agentRef)) === bound;
    } catch {
        return false;
    }
}

export function mcpBoundAgentMismatch(): NextResponse {
    return NextResponse.json({ error: BOUND_AGENT_MISMATCH }, { status: 403 });
}

/**
 * Agent record fields only an owner/admin may change (from the UI, or an
 * operator token): spend, budget, model, model policy, concurrency, data
 * scope, doctrine and deployment. An agent never sets these on itself.
 */
export const OWNER_ONLY_AGENT_FIELDS = [
    "monthlyBudgetCents", "monthlyCostCents", "monthlyTokenUsage", "budgetStatus",
    "llmProvider", "llmModel", "modelPolicyJson", "concurrencyLimit",
    "scopeJson", "doctrineJson", "deploymentMode", "provider",
] as const;

/**
 * May this token update that agent record with these fields? A bound token may
 * only update ITS OWN agent, and only non-privileged fields (name, role,
 * skills, memory, avatar). Operator tokens are unrestricted. Returns the
 * denial message, or null when allowed.
 */
export async function mcpAgentUpdateDenial(
    companyId: string,
    token: { agentId?: string | null } | null | undefined,
    targetAgentRef: string,
    fields: Record<string, unknown>,
): Promise<string | null> {
    if (!token?.agentId) return null;
    if (!(await mcpTokenMayActOnAgent(companyId, token, targetAgentRef))) {
        return "Access denied: an agent can only update its own record";
    }
    const privileged = OWNER_ONLY_AGENT_FIELDS.filter((field) => fields[field] !== undefined);
    return privileged.length > 0
        ? `Access denied: ${privileged.join(", ")} can only be changed by an owner or admin`
        : null;
}

/** Map an McpAccessError to its JSON response; null for anything else. */
export function mcpAccessErrorResponse(error: unknown): NextResponse | null {
    if (error instanceof McpAccessError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return null;
}

/**
 * Route convenience: resolve access or produce the error response.
 *   const scoped = await mcpRouteAccess(companyId, auth.companyToken!, agentIdParam);
 *   if (scoped.response) return scoped.response;
 */
export async function mcpRouteAccess(
    companyId: string,
    token: { agentId?: string | null } | null | undefined,
    requestedAgentId?: unknown,
): Promise<{ access: McpAgentAccess; response?: undefined } | { access?: undefined; response: NextResponse }> {
    try {
        return { access: await resolveMcpAgentAccess(companyId, token, requestedAgentId) };
    } catch (error) {
        const response = mcpAccessErrorResponse(error);
        if (response) return { response };
        throw error;
    }
}

/**
 * One-line guard for a record loaded by id: resolves the caller's access (token
 * binding, or ?agentId= for an operator token) and answers 404 when the record
 * belongs to a project/customer outside the scope. null = may proceed.
 */
export async function mcpDenyOutOfScope(
    req: { nextUrl: URL } | null,
    companyId: string,
    token: { agentId?: string | null } | null | undefined,
    record: { projectId?: string | null; customerId?: string | null },
    what = "Resource",
): Promise<NextResponse | null> {
    const scoped = await mcpRouteAccess(companyId, token, req?.nextUrl.searchParams.get("agentId") ?? null);
    if (scoped.response) return scoped.response;
    return mcpMayUseRecord(scoped.access, record) ? null : mcpOutOfScope(what);
}

/** Generic "not found" used when a record exists but is outside the caller's scope (never confirms it exists). */
export function mcpOutOfScope(what = "Resource"): NextResponse {
    return NextResponse.json({ error: `${what} not found` }, { status: 404 });
}
