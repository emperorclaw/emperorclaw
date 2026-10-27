import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { agents, auditLog, companyMembers, customers, projects, users } from "@/db/schema";
import {
    AUDIT_TARGET_TYPES, auditTargetHref, describeAuditEntry, isAuditTargetType, redactAuditPayload,
    type AuditActorType, type AuditPayload, type AuditSentence,
} from "@/lib/audit-format";
import { splitProjectTitle } from "@/lib/project-title";

export const ACTIVITY_PAGE_SIZE = 50;
export const ACTIVITY_PAGE_MAX = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;

export type ActivityFilter = {
    actorType?: AuditActorType | null;
    actorId?: string | null;
    targetType?: string | null;
    from?: Date | null;
    to?: Date | null;
};

export type ActivityItem = {
    id: string;
    createdAt: string;
    action: string;
    targetType: string;
    targetId: string;
    actor: { type: string; id: string | null; name: string | null };
    sentence: AuditSentence;
    href: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    /** Rows written together (a bulk archive) share it. */
    batch: string | null;
};

export type ActivityPage = { items: ActivityItem[]; nextCursor: string | null; names: Record<string, string> };

/**
 * Cursor = the last row's (created_at, id). created_at travels as Postgres
 * text with microseconds: a JS Date would round to milliseconds and skip or
 * repeat rows written in the same millisecond.
 */
export function encodeActivityCursor(createdAt: string, id: string): string {
    return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

export function decodeActivityCursor(cursor: string | null | undefined): { createdAt: string; id: string } | null {
    if (!cursor) return null;
    try {
        const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
        return createdAt && id && CURSOR_TS_RE.test(createdAt) && UUID_RE.test(id) ? { createdAt, id } : null;
    } catch {
        return null;
    }
}

/** Query-string filters, validated; anything malformed is an error, not ignored. */
export function parseActivityQuery(params: URLSearchParams): { filter: ActivityFilter; cursor: string | null; limit: number } | { error: string } {
    const actorType = params.get("actorType") || null;
    if (actorType && actorType !== "human" && actorType !== "agent" && actorType !== "system") return { error: "actorType must be human, agent or system" };
    const actorId = params.get("actorId") || null;
    if (actorId && !UUID_RE.test(actorId)) return { error: "actorId must be a uuid" };
    const targetType = params.get("targetType") || null;
    if (targetType && !isAuditTargetType(targetType)) return { error: `targetType must be one of ${AUDIT_TARGET_TYPES.join(", ")}` };
    const date = (key: string) => {
        const raw = params.get(key);
        if (!raw) return null;
        const value = new Date(raw);
        return Number.isNaN(value.getTime()) ? undefined : value;
    };
    const from = date("from");
    const to = date("to");
    if (from === undefined || to === undefined) return { error: "from and to must be ISO dates" };
    const rawLimit = params.get("limit");
    const limit = rawLimit === null ? ACTIVITY_PAGE_SIZE : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_PAGE_MAX) return { error: `limit must be 1-${ACTIVITY_PAGE_MAX}` };
    const cursor = params.get("cursor") || null;
    if (cursor && !decodeActivityCursor(cursor)) return { error: "Invalid cursor" };
    return { filter: { actorType: actorType as AuditActorType | null, actorId, targetType, from, to }, cursor, limit };
}

function collectIds(value: unknown, into: Set<string>) {
    if (typeof value === "string" && UUID_RE.test(value)) into.add(value);
    else if (Array.isArray(value)) for (const v of value) collectIds(v, into);
    else if (value && typeof value === "object") for (const v of Object.values(value)) collectIds(v, into);
}

/** Display names for every id the page mentions (people, agents, members, projects, customers). */
async function resolveNames(companyId: string, ids: Set<string>): Promise<Record<string, string>> {
    const list = [...ids];
    if (list.length === 0) return {};
    const [agentRows, userRows, memberRows, projectRows, customerRows] = await Promise.all([
        db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, list))),
        db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users)
            .innerJoin(companyMembers, and(eq(companyMembers.userId, users.id), eq(companyMembers.companyId, companyId)))
            .where(inArray(users.id, list)),
        db.select({ id: companyMembers.id, displayName: users.displayName, email: users.email }).from(companyMembers)
            .innerJoin(users, eq(users.id, companyMembers.userId))
            .where(and(eq(companyMembers.companyId, companyId), inArray(companyMembers.id, list))),
        db.select({ id: projects.id, goal: projects.goal }).from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, list))),
        db.select({ id: customers.id, name: customers.name }).from(customers).where(and(eq(customers.companyId, companyId), inArray(customers.id, list))),
    ]);
    const names: Record<string, string> = {};
    for (const row of agentRows) names[row.id] = row.name;
    for (const row of [...userRows, ...memberRows]) names[row.id] = row.displayName || row.email;
    for (const row of projectRows) names[row.id] = splitProjectTitle(row.goal).name;
    for (const row of customerRows) names[row.id] = row.name;
    return names;
}

/**
 * One page of the company's activity, newest first. Only the known target
 * types are listed (older agent-side rows such as artifact uploads are not
 * activity), and every payload is re-redacted on read.
 */
export async function listActivity(companyId: string, filter: ActivityFilter, cursor: string | null, limit = ACTIVITY_PAGE_SIZE): Promise<ActivityPage> {
    const conditions: SQL[] = [eq(auditLog.companyId, companyId)];
    conditions.push(filter.targetType ? eq(auditLog.targetType, filter.targetType) : inArray(auditLog.targetType, [...AUDIT_TARGET_TYPES]));
    if (filter.actorType) conditions.push(eq(auditLog.actorType, filter.actorType));
    if (filter.actorId) conditions.push(eq(auditLog.actorId, filter.actorId));
    if (filter.from) conditions.push(gte(auditLog.createdAt, filter.from));
    if (filter.to) conditions.push(lte(auditLog.createdAt, filter.to));
    const after = decodeActivityCursor(cursor);
    if (after) conditions.push(sql`(${auditLog.createdAt}, ${auditLog.id}) < (${after.createdAt}::timestamp, ${after.id}::uuid)`);

    const rows = await db.select({
        id: auditLog.id,
        createdAt: auditLog.createdAt,
        cursorAt: sql<string>`to_char(${auditLog.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        payloadJson: auditLog.payloadJson,
    }).from(auditLog)
        .where(and(...conditions))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(Math.min(Math.max(limit, 1), ACTIVITY_PAGE_MAX) + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const payloads = new Map<string, AuditPayload>(pageRows.map((row) => [row.id, redactAuditPayload(row.targetType, row.payloadJson)]));

    const ids = new Set<string>();
    for (const row of pageRows) {
        if (row.actorId) ids.add(row.actorId);
        const payload = payloads.get(row.id)!;
        collectIds(payload.before, ids);
        collectIds(payload.after, ids);
    }
    const names = await resolveNames(companyId, ids);

    const items = pageRows.map((row): ActivityItem => {
        const payload = payloads.get(row.id)!;
        const actorName = row.actorId ? names[row.actorId] ?? null : null;
        return {
            id: row.id,
            createdAt: row.createdAt.toISOString(),
            action: row.action,
            targetType: row.targetType,
            targetId: row.targetId,
            actor: { type: row.actorType, id: row.actorId, name: actorName },
            sentence: describeAuditEntry({ action: row.action, targetType: row.targetType, targetId: row.targetId, payload, actorType: row.actorType, actorName }, names),
            href: auditTargetHref(row.targetType, row.targetId, payload),
            before: payload.before ?? null,
            after: payload.after ?? null,
            batch: typeof payload.meta?.batch === "string" ? payload.meta.batch : null,
        };
    });
    const last = pageRows.at(-1);
    return { items, nextCursor: hasMore && last ? encodeActivityCursor(last.cursorAt, last.id) : null, names };
}

/** The people and agents the actor filter offers. */
export async function listActivityActors(companyId: string) {
    const [people, roster] = await Promise.all([
        db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(companyMembers)
            .innerJoin(users, eq(users.id, companyMembers.userId)).where(eq(companyMembers.companyId, companyId)),
        db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.companyId, companyId)).orderBy(agents.name),
    ]);
    return {
        people: people.map((p) => ({ id: p.id, name: p.displayName || p.email })).sort((a, b) => a.name.localeCompare(b.name)),
        agents: roster.map((a) => ({ id: a.id, name: a.name })),
    };
}
