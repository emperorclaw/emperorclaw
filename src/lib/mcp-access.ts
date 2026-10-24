import { NextResponse } from "next/server";
import { and, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { projects, tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { normalizeAgentRef, resolveAgentId } from "@/lib/mcp";
import { isAgentAllowed, isCustomerAllowed, isProjectAllowed, loadAgentScopeContext, scopeCondition } from "@/lib/agent-scope";
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
    /** Agents it may see/message/hand work to (always itself); null = all. */
    allowedAgentIds: Set<string> | null;
};

export const UNRESTRICTED_MCP_ACCESS: McpAgentAccess = Object.freeze({
    agentId: null,
    bound: false,
    allowedProjectIds: null,
    allowedCustomerIds: null,
    allowedAgentIds: null,
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
    const { allowedProjectIds, allowedCustomerIds, allowedAgentIds } = await loadAgentScopeContext(companyId, agentId);
    return { agentId, bound: Boolean(bound), allowedProjectIds, allowedCustomerIds, allowedAgentIds };
}

/** Access for a caller whose agent is already known (e.g. an MCP tool session bound to an agent). */
export async function mcpAccessForAgent(companyId: string, agentId: string | null | undefined): Promise<McpAgentAccess> {
    return resolveMcpAgentAccess(companyId, { agentId: agentId ?? null });
}

export function isMcpAccessRestricted(access: McpAgentAccess): boolean {
    return access.allowedProjectIds !== null || access.allowedCustomerIds !== null;
}

/** May the acting agent see / message / hand work to this agent? (One-way: only the actor's list counts.) */
export function mcpMayReachAgent(access: McpAgentAccess, agentId: string | null | undefined): boolean {
    return isAgentAllowed(access.allowedAgentIds, agentId);
}

/** SQL twin of mcpMayReachAgent for agent-id columns (undefined = no filter). */
export function mcpAgentCondition(access: McpAgentAccess, column: AnyColumn): SQL | undefined {
    return scopeCondition(access.allowedAgentIds, column);
}

/** The error an agent gets when it tries to reach an agent outside its list. */
export class McpUnreachableAgentError extends Error {
    constructor(name: string) {
        super(`You can't reach ${name}: that agent is outside your scope`);
        this.name = "McpUnreachableAgentError";
    }
}

/**
 * Throws McpUnreachableAgentError when the agent is out of reach. The message
 * names the agent only when it is a name the caller already used.
 *
 * The ref is normalized and resolved exactly as the guarded write resolves it
 * (resolveAgentId). A restricted caller fails CLOSED: a ref this check cannot
 * resolve is refused here (404) rather than left for the write to interpret.
 */
export async function assertMcpMayReachAgent(companyId: string, access: McpAgentAccess, agentRef: string | null | undefined): Promise<void> {
    if (!access.allowedAgentIds || typeof agentRef !== "string") return;
    const ref = normalizeAgentRef(agentRef);
    if (!ref) return; // nothing named; the write rejects or ignores an empty ref
    let resolved: string;
    try {
        resolved = await resolveAgentId(companyId, ref);
    } catch {
        throw new McpAccessError(`Agent not found: ${ref}`, 404);
    }
    if (!mcpMayReachAgent(access, resolved)) throw new McpUnreachableAgentError(ref);
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
    if (error instanceof McpUnreachableAgentError) {
        return NextResponse.json({ error: error.message }, { status: 403 });
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

/** An agent adding agents to a group may only add agents it can work with. */
export async function assertMcpMayAddAgents(companyId: string, actorAgentId: string | null | undefined, agentRefs: unknown): Promise<void> {
    if (!actorAgentId || !Array.isArray(agentRefs)) return;
    const access = await mcpAccessForAgent(companyId, actorAgentId);
    for (const ref of agentRefs) if (typeof ref === "string") await assertMcpMayReachAgent(companyId, access, ref);
}

/**
 * Handing work to an agent (assignedAgentId, an agent `assignee`, a claim or
 * an assignment): the target must be inside the acting agent's list.
 */
export async function assertMcpMayAssign(
    companyId: string,
    access: McpAgentAccess,
    body: { assignedAgentId?: unknown; assignee?: unknown; agentId?: unknown },
): Promise<void> {
    if (!access.allowedAgentIds) return;
    const refs: string[] = [];
    if (typeof body.assignedAgentId === "string" && body.assignedAgentId) refs.push(body.assignedAgentId);
    if (typeof body.agentId === "string" && body.agentId) refs.push(body.agentId);
    const assignee = body.assignee as { type?: unknown; id?: unknown } | null | undefined;
    if (assignee && assignee.type === "agent" && typeof assignee.id === "string") refs.push(assignee.id);
    for (const ref of refs) await assertMcpMayReachAgent(companyId, access, ref);
}
