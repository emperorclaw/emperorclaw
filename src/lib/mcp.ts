import { NextRequest } from "next/server";
import { db } from "@/db";
import { companyTokens, idempotencyKeys, auditLog, agents, agentSessions, projects, tasks } from "@/db/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import * as crypto from "crypto";

type JsonObject = Record<string, unknown>;
export type CompanyTokenScope = "mcp_full" | "mcp_danger";

export type McpTaskScopeContext = {
    id: string;
    projectId: string;
    customerId: string | null;
    assignedAgentId: string | null;
};

export type McpActorContext = {
    callerAgentId: string | null;
    sessionId: string | null;
    task: McpTaskScopeContext | null;
};

type VerifyMcpTokenSuccess = {
    companyToken: typeof companyTokens.$inferSelect;
    expiresAt: Date;
    error?: undefined;
    status?: undefined;
};

type VerifyMcpTokenFailure = {
    error: string;
    status: number;
    companyToken?: undefined;
    expiresAt?: undefined;
};

export type VerifyMcpTokenResult = VerifyMcpTokenSuccess | VerifyMcpTokenFailure;

type VerifyMcpTokenOptions = {
    requiredScope?: CompanyTokenScope;
};

function getPositiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isCompanyTokenScope(value: unknown): value is CompanyTokenScope {
    return value === "mcp_full" || value === "mcp_danger";
}

export function normalizeCompanyTokenScope(value: unknown): CompanyTokenScope {
    return value === "mcp_danger" ? "mcp_danger" : "mcp_full";
}

function getCompanyTokenScopeRank(scope: CompanyTokenScope): number {
    return scope === "mcp_danger" ? 2 : 1;
}

export function hasRequiredCompanyTokenScope(actual: unknown, required: CompanyTokenScope): boolean {
    return getCompanyTokenScopeRank(normalizeCompanyTokenScope(actual)) >= getCompanyTokenScopeRank(required);
}

function getCompanyTokenTtlDays(scope: CompanyTokenScope): number {
    return scope === "mcp_danger"
        ? getPositiveIntegerEnv("EMPEROR_CLAW_DANGER_TOKEN_TTL_DAYS", 30)
        : getPositiveIntegerEnv("EMPEROR_CLAW_TOKEN_TTL_DAYS", 90);
}

export function getCompanyTokenExpiresAt(token: { createdAt: Date; scope: unknown }): Date {
    const expiresAt = new Date(token.createdAt);
    expiresAt.setDate(expiresAt.getDate() + getCompanyTokenTtlDays(normalizeCompanyTokenScope(token.scope)));
    return expiresAt;
}

export function serializeCompanyToken(token: {
    id: string;
    name: string;
    scope: unknown;
    createdAt: Date;
    lastUsedAt?: Date | null;
    revokedAt?: Date | null;
}) {
    return {
        id: token.id,
        name: token.name,
        scope: normalizeCompanyTokenScope(token.scope),
        createdAt: token.createdAt.toISOString(),
        lastUsedAt: token.lastUsedAt ? token.lastUsedAt.toISOString() : null,
        revokedAt: token.revokedAt ? token.revokedAt.toISOString() : null,
        expiresAt: getCompanyTokenExpiresAt(token).toISOString(),
    };
}

async function verifyStoredCompanyToken(
    companyToken: typeof companyTokens.$inferSelect | undefined,
    options: VerifyMcpTokenOptions,
): Promise<VerifyMcpTokenResult> {
    if (!companyToken || companyToken.revokedAt) {
        return { error: "Invalid or revoked token", status: 401 as const };
    }

    const expiresAt = getCompanyTokenExpiresAt(companyToken);
    if (expiresAt.getTime() <= Date.now()) {
        return { error: "Token expired", status: 401 as const };
    }

    if (options.requiredScope && !hasRequiredCompanyTokenScope(companyToken.scope, options.requiredScope)) {
        return { error: `Token scope ${normalizeCompanyTokenScope(companyToken.scope)} cannot access this endpoint`, status: 403 as const };
    }

    db.update(companyTokens).set({ lastUsedAt: new Date() }).where(eq(companyTokens.id, companyToken.id)).execute().catch(console.error);
    return { companyToken, expiresAt };
}

export async function verifyMcpAuthorizationHeader(
    authHeader: string | string[] | null | undefined,
    options: VerifyMcpTokenOptions = {},
): Promise<VerifyMcpTokenResult> {
    const normalizedHeader = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!normalizedHeader || !normalizedHeader.startsWith("Bearer ")) {
        return { error: "Missing or invalid Authorization header", status: 401 };
    }

    const token = normalizedHeader.split(" ")[1];
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const [companyToken] = await db.select().from(companyTokens).where(
        eq(companyTokens.tokenHash, tokenHash)
    ).limit(1);

    return verifyStoredCompanyToken(companyToken, options);
}

export async function verifyMcpToken(req: NextRequest, options: VerifyMcpTokenOptions = {}) {
    return verifyMcpAuthorizationHeader(req.headers.get("authorization"), options);
}

export async function checkIdempotency(req: NextRequest, companyId: string, endpoint: string) {
    const idempotencyKey = req.headers.get("Idempotency-Key");
    if (!idempotencyKey) {
        return { error: "Idempotency-Key header is required", status: 400 };
    }

    // Generate request hash (simplified by just using the key and endpoint)
    const requestHash = crypto.createHash('sha256').update(`${idempotencyKey}:${endpoint}`).digest('hex');

    const [existing] = await db.select().from(idempotencyKeys).where(
        and(
            eq(idempotencyKeys.companyId, companyId),
            eq(idempotencyKeys.requestHash, requestHash)
        )
    ).limit(1);

    if (existing && existing.responseSnapshot) {
        return { cachedResponse: existing.responseSnapshot };
    }

    return { requestHash };
}

export async function saveIdempotencyResponse(companyId: string, endpoint: string, requestHash: string, responseObj: JsonObject) {
    await db.insert(idempotencyKeys).values({
        companyId,
        endpoint,
        requestHash,
        responseSnapshot: responseObj,
    });
}

export async function resolveAgentId(
    companyId: string,
    providedAgentId: string,
    options: { autoCreate?: boolean } = {}
): Promise<string> {
    // 1. Try to fetch existing agent UUID by their string name identifier
    const [agent] = await db.select().from(agents).where(
        and(eq(agents.companyId, companyId), eq(agents.name, providedAgentId), isNull(agents.deletedAt))
    ).limit(1);

    if (agent) return agent.id;

    // 2. If it's literally a valid UUID passed already, just check it exists
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(providedAgentId)) {
        const [existing] = await db.select().from(agents).where(
            and(eq(agents.companyId, companyId), eq(agents.id, providedAgentId), isNull(agents.deletedAt))
        ).limit(1);
        if (existing) return existing.id;
    }

    if (!options.autoCreate) {
        throw new Error(`Agent not found: ${providedAgentId}`);
    }

    // 3. Explicit fallback: auto-register this new agent string with a fresh UUID
    const [newAgent] = await db.insert(agents).values({
        companyId,
        name: providedAgentId,
        status: "online",
        role: "operator",
    }).returning();

    return newAgent.id;
}

export async function resolveMcpActorContext(
    companyId: string,
    input: {
        agentId?: string | null;
        sessionId?: string | null;
        taskId?: string | null;
    }
): Promise<McpActorContext> {
    let callerAgentId: string | null = null;

    if (input.agentId) {
        callerAgentId = await resolveAgentId(companyId, input.agentId);
    }

    if (input.sessionId) {
        const [session] = await db.select({
            id: agentSessions.id,
            agentId: agentSessions.agentId,
        }).from(agentSessions).where(and(
            eq(agentSessions.companyId, companyId),
            eq(agentSessions.id, input.sessionId),
        )).limit(1);

        if (!session) {
            throw new Error("Session not found");
        }

        if (callerAgentId && session.agentId !== callerAgentId) {
            throw new Error("Access denied: session does not belong to the requested agent");
        }

        callerAgentId = callerAgentId || session.agentId;
    }

    let task: McpTaskScopeContext | null = null;
    if (input.taskId) {
        const [taskRow] = await db.select({
            id: tasks.id,
            projectId: tasks.projectId,
            customerId: projects.customerId,
            assignedAgentId: tasks.assignedAgentId,
        }).from(tasks)
            .innerJoin(projects, eq(tasks.projectId, projects.id))
            .where(and(
                eq(tasks.companyId, companyId),
                eq(tasks.id, input.taskId),
                isNull(tasks.deletedAt),
                isNull(projects.deletedAt),
            ))
            .limit(1);

        if (!taskRow) {
            throw new Error("Task not found");
        }

        task = taskRow;
    }

    return {
        callerAgentId,
        sessionId: input.sessionId || null,
        task,
    };
}

export async function logAudit(companyId: string, actorType: string, actorId: string | null, action: string, targetType: string, targetId: string, payload: JsonObject = {}) {
    await db.insert(auditLog).values({
        companyId,
        actorType,
        actorId,
        action,
        targetType,
        targetId,
        payloadJson: payload,
    }).execute().catch(console.error);
}

export async function notifyMcpEvent(companyId: string, payload: { type: string } & JsonObject) {
    // Broadcast via Postgres NOTIFY mcp_events
    // We escape single quotes in JSON string for SQL safety
    const jsonStr = JSON.stringify({ companyId, payload }).replace(/'/g, "''");
    await db.execute(sql`SELECT pg_notify('mcp_events', ${jsonStr})`);
}
