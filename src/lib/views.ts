// Views (roadmap 0.15): dashboards an agent builds and keeps up to date.
//
// One service for both callers: agents (MCP tools and the /api/mcp/views REST
// twin) and people (/api/views and the /views pages). Who may see a view is
// decided in ONE place, lib/view-access.ts (viewAccess), fed here by
// accessFor/accessChecker: the view's scope is the ceiling (company views are
// open, customer and project views follow the caller's scope), and inside it
// the view's visibility (private / shared / scope, 0.19) narrows it to its
// owner, the people it is shared with and its maintaining agent. Owners and
// admins outside a private view get its metadata only. A view the caller may
// not see at all reads exactly like one that does not exist
// (ViewNotFoundError), so ids are not an existence oracle.
//
// The layout (views.spec_json, versioned in view_versions) and the values
// (view_panel_data, one row per panel) are stored apart: update_panel writes
// one data row and never touches the layout or its version.

import { and, asc, desc, eq, exists, inArray, isNull, isNotNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
    agents, companyMembers, customers, messageThreads, projects, threadMessages, threadParticipants, users,
    viewPanelData, viewPins, viewShares, views, viewVersions,
} from "@/db/schema";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { broadcastMcpEvent, broadcastUserEvent } from "@/lib/pubsub";
import { NextResponse } from "next/server";
import { mcpAccessErrorResponse, mcpMayUseResource, mcpMayWriteResourceScope, type McpAgentAccess } from "@/lib/mcp-access";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getScopedCustomerIds, memberMaySeeResource, memberVisibleProjectIds, resolveMemberScope, type MemberScope } from "@/lib/member-scope";
import type { Role } from "@/lib/role-matrix";
import {
    jsonBytes, parsePanelData, parseViewDescription, parseViewPanels, parseViewTitle, planViewVersion, storedPanelData, storedViewSpec,
    VIEW_SCOPE_TYPES, VIEW_TOTAL_DATA_MAX_BYTES,
    type MetricPanelData, type ViewPanelData, type ViewPanelLayout, type ViewScopeType, type ViewSpec,
} from "@/lib/view-spec";
import {
    AGENT_VIEW_VISIBILITIES, VIEW_VISIBILITIES, defaultViewVisibility, maintainerAgentId, parseRefreshEveryMinutes, pickViewOwner, viewAccess,
    type ViewAccess, type ViewAccessSubject, type ViewVisibility,
} from "@/lib/view-access";

/** Versions kept per view; older ones are pruned when a new one is written. */
export const VIEW_VERSIONS_KEPT = 50;

/** Views (not archived) one company may hold; past it create_view answers 409. */
export const VIEW_MAX_ACTIVE_PER_COMPANY = 200;

/** People one view may be shared with. */
export const VIEW_MAX_SHARES = 50;

/**
 * update_panel calls one caller may make on one view per minute (429 past it).
 * In-memory per process (lib/rate-limit.ts), like the MCP request limiter: the
 * supported deployment is a single process.
 */
export const VIEW_PANEL_UPDATES_PER_MINUTE = 60;

/** At most one view_updated broadcast per view per this window (trailing). */
const VIEW_ANNOUNCE_INTERVAL_MS = 2_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Both missing and out-of-scope: the caller never learns which. */
export class ViewNotFoundError extends Error {
    constructor() {
        super("View not found");
        this.name = "ViewNotFoundError";
    }
}

/**
 * A request refused for who is asking or how often: 403 (an agent writing a
 * view it did not build, a person opening a private view they only see the
 * name of), 409 (company view cap), 429 (panel update rate).
 */
export class ViewRefusedError extends Error {
    readonly status: 403 | 409 | 429;
    constructor(message: string, status: 403 | 409 | 429) {
        super(message);
        this.name = "ViewRefusedError";
        this.status = status;
    }
}

export const VIEW_NOT_OWNER_MESSAGE = "Only the agent that built this view (or a person) can change it";
export const VIEW_PRIVATE_MESSAGE = "This view is private: only its owner and the people it is shared with can open it";

/** A request the caller can fix (bad spec, bad scope, unknown panel). */
export class ViewInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ViewInputError";
    }
}

/**
 * Who is reading or writing. Agents carry their MCP access (an operator token
 * naming no agent is unrestricted by scope but never sees private views);
 * people carry their role and member scope (null for admins and unrestricted
 * members). The route checks the minimum role (viewer reads, member writes).
 */
export type ViewCaller =
    | { kind: "agent"; access: McpAgentAccess; actor: AuditActor }
    | { kind: "member"; userId: string; scope: MemberScope | null; role: Role };

/** The member caller for a route or page guard context. */
export function memberViewCaller(ctx: { userId: string; scope: MemberScope | null; role: Role }): ViewCaller {
    return { kind: "member", userId: ctx.userId, scope: ctx.scope, role: ctx.role };
}

function isAdminRole(role: Role): boolean {
    return role === "owner" || role === "admin" || role === "instance_admin";
}

function subjectOf(caller: ViewCaller): ViewAccessSubject {
    return caller.kind === "agent"
        ? { kind: "agent", agentId: caller.access.agentId }
        : { kind: "member", userId: caller.userId, isAdmin: isAdminRole(caller.role) };
}

function actorOf(caller: ViewCaller): AuditActor {
    return caller.kind === "agent" ? caller.actor : { type: "human", id: caller.userId };
}

// Fleet bridges use company-wide tokens, so a maintaining agent refreshing its
// private view would log a trace every time. One trace per view and agent a day
// keeps the signal without flooding Activity.
const UNBOUND_READ_TRACE_MS = 24 * 60 * 60 * 1000;
const lastUnboundRead = new Map<string, number>();

function firstUnboundReadToday(viewId: string, actorId: string | null | undefined, now = Date.now()): boolean {
    const key = `${viewId}:${actorId ?? "-"}`;
    const last = lastUnboundRead.get(key);
    if (last !== undefined && now - last < UNBOUND_READ_TRACE_MS) return false;
    if (lastUnboundRead.size > 10_000) lastUnboundRead.clear();
    lastUnboundRead.set(key, now);
    return true;
}

/** The (type, id) pair stored in created_by / updated_by / author columns. */
function stamp(caller: ViewCaller): { type: "agent" | "human" | "system"; id: string | null } {
    const actor = actorOf(caller);
    const id = actor.id && UUID_RE.test(actor.id) ? actor.id : null;
    return { type: actor.type, id };
}

type ViewRow = typeof views.$inferSelect;

// ─── Access (the only place facts are gathered for viewAccess) ───────────────

async function sharesOf(viewIds: string[]): Promise<Map<string, string[]>> {
    const ids = viewIds.filter((id) => UUID_RE.test(id));
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    const rows = await db.select({ viewId: viewShares.viewId, userId: viewShares.userId }).from(viewShares).where(inArray(viewShares.viewId, ids));
    for (const row of rows) out.set(row.viewId, [...(out.get(row.viewId) ?? []), row.userId]);
    return out;
}

/** The caller's scope ceiling as a per-row check (one project lookup for a whole list). */
async function scopeChecker(companyId: string, caller: ViewCaller): Promise<(row: { scopeType: string; scopeId: string | null }) => boolean> {
    if (caller.kind === "agent") return (row) => mcpMayUseResource(caller.access, row);
    const scope = caller.scope;
    if (!scope) return () => true;
    const customerIds = new Set(getScopedCustomerIds(scope) ?? []);
    const projectIds = (await memberVisibleProjectIds(companyId, scope)) ?? new Set<string>();
    return (row) => row.scopeType === "company"
        || (row.scopeType === "customer" && Boolean(row.scopeId) && customerIds.has(row.scopeId!))
        || (row.scopeType === "project" && Boolean(row.scopeId) && projectIds.has(row.scopeId!));
}

/** viewAccess for many rows at once. */
async function accessChecker(companyId: string, caller: ViewCaller, rows: ViewRow[]): Promise<Map<string, ViewAccess>> {
    const [inScope, shares] = await Promise.all([scopeChecker(companyId, caller), sharesOf(rows.filter((r) => r.visibility === "shared").map((r) => r.id))]);
    const subject = subjectOf(caller);
    return new Map(rows.map((row) => [row.id, viewAccess(subject, { ...row, sharedWith: shares.get(row.id) ?? [] }, inScope(row))]));
}

/** What this caller may do with one view: "full", "metadata" or "none". */
export async function accessFor(companyId: string, caller: ViewCaller, row: ViewRow): Promise<ViewAccess> {
    return (await accessChecker(companyId, caller, [row])).get(row.id) ?? "none";
}

/**
 * SQL prefilter for lists (undefined = no filter). It only narrows the rows
 * fetched; accessChecker still decides every row it returns.
 */
async function readCondition(companyId: string, caller: ViewCaller): Promise<SQL | undefined> {
    let customerIds: string[] | null;
    let projectIds: string[] | null;
    let visible: SQL | undefined;
    if (caller.kind === "agent") {
        const agentId = caller.access.agentId;
        visible = agentId
            ? or(eq(views.visibility, "scope"), and(eq(views.createdByType, "agent"), eq(views.createdById, agentId)))
            : eq(views.visibility, "scope");
        if (!agentId) return visible;
        customerIds = caller.access.allowedCustomerIds ? [...caller.access.allowedCustomerIds] : null;
        projectIds = caller.access.allowedProjectIds ? [...caller.access.allowedProjectIds] : null;
    } else {
        // Admins also list the private views they are not part of (as metadata).
        visible = isAdminRole(caller.role) ? undefined : or(
            eq(views.visibility, "scope"),
            eq(views.ownerUserId, caller.userId),
            and(eq(views.visibility, "shared"), exists(db.select({ one: sql`1` }).from(viewShares)
                .where(and(eq(viewShares.viewId, views.id), eq(viewShares.userId, caller.userId))))),
        );
        if (!caller.scope) return visible;
        customerIds = getScopedCustomerIds(caller.scope) ?? [];
        projectIds = [...((await memberVisibleProjectIds(companyId, caller.scope)) ?? new Set<string>())];
    }
    if (!customerIds && !projectIds) return visible;
    const allowed = (type: ViewScopeType, ids: string[] | null) => ids === null
        ? eq(views.scopeType, type)
        : ids.length > 0 ? and(eq(views.scopeType, type), inArray(views.scopeId, ids)) : undefined;
    return and(visible, or(eq(views.scopeType, "company"), allowed("customer", customerIds), allowed("project", projectIds)));
}

/** A company member, with what is needed to check they may see a scope. */
async function companyPerson(companyId: string, userId: unknown): Promise<{ userId: string; scope: MemberScope | null; name: string } | null> {
    if (typeof userId !== "string" || !UUID_RE.test(userId)) return null;
    const [row] = await db.select({ role: companyMembers.role, scopeJson: companyMembers.scopeJson, instanceRole: users.instanceRole, name: users.displayName, email: users.email })
        .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
        .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId), isNull(users.deletedAt))).limit(1);
    if (!row) return null;
    const unrestricted = row.role === "owner" || row.role === "admin" || row.instanceRole === "instance_admin";
    return { userId, scope: unrestricted ? null : await resolveMemberScope(companyId, userId, row.scopeJson), name: row.name || row.email.split("@")[0] };
}

/** A person who may own or be shared a view filed under this scope. */
async function personInScope(companyId: string, userId: unknown, scope: { scopeType: string; scopeId: string | null }) {
    const person = await companyPerson(companyId, userId);
    if (!person || !(await memberMaySeeResource(companyId, person.scope, scope))) return null;
    return person;
}

/** The scope a caller wants to file a view under: must exist in this company and be inside their scope. */
async function checkWritableScope(companyId: string, caller: ViewCaller, scopeType: unknown, scopeId: unknown): Promise<{ scopeType: ViewScopeType; scopeId: string | null }> {
    const type = (scopeType ?? "company") as ViewScopeType;
    if (!(VIEW_SCOPE_TYPES as readonly string[]).includes(type)) throw new ViewInputError(`scope must be one of: ${VIEW_SCOPE_TYPES.join(", ")}`);
    if (type === "company") return { scopeType: "company", scopeId: null };
    if (typeof scopeId !== "string" || !UUID_RE.test(scopeId)) throw new ViewInputError(`scopeId (a ${type} id) is required for a ${type} view`);
    const exists_ = type === "customer"
        ? (await db.select({ id: customers.id }).from(customers).where(and(eq(customers.companyId, companyId), eq(customers.id, scopeId), isNull(customers.deletedAt))).limit(1)).length > 0
        : (await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, scopeId), isNull(projects.deletedAt))).limit(1)).length > 0;
    const allowed = caller.kind === "agent"
        ? mcpMayWriteResourceScope(caller.access, type, scopeId)
        : await memberMaySeeResource(companyId, caller.scope, { scopeType: type, scopeId });
    // Missing and out-of-scope read the same.
    if (!exists_ || !allowed) throw new ViewInputError(`That ${type} was not found or is outside your scope`);
    return { scopeType: type, scopeId };
}

/**
 * Who may change a view it can fully see. People: the route already requires
 * member or above. Agents: only the views they built. An operator token
 * naming no agent is unrestricted, as everywhere in MCP.
 */
function assertMayWrite(caller: ViewCaller, row: { createdByType: string; createdById: string | null }): void {
    if (caller.kind !== "agent" || !caller.access.agentId) return;
    if (row.createdByType === "agent" && row.createdById === caller.access.agentId) return;
    throw new ViewRefusedError(VIEW_NOT_OWNER_MESSAGE, 403);
}

/**
 * Load a view the caller may see, or throw ViewNotFoundError. `need: "full"`
 * (the default) refuses a metadata-only caller with a 403. Archived views
 * only with `includeArchived`.
 */
async function loadVisibleView(
    companyId: string, caller: ViewCaller, viewId: string,
    options: { includeArchived?: boolean; need?: "full" | "metadata" } = {},
): Promise<{ row: ViewRow; access: Exclude<ViewAccess, "none"> }> {
    if (typeof viewId !== "string" || !UUID_RE.test(viewId)) throw new ViewNotFoundError();
    const [row] = await db.select().from(views).where(and(eq(views.companyId, companyId), eq(views.id, viewId))).limit(1);
    if (!row || (row.archivedAt && !options.includeArchived)) throw new ViewNotFoundError();
    const access = await accessFor(companyId, caller, row);
    if (access === "none") throw new ViewNotFoundError();
    if (access === "metadata" && (options.need ?? "full") === "full") throw new ViewRefusedError(VIEW_PRIVATE_MESSAGE, 403);
    return { row, access };
}

/**
 * What the audit log keeps of a view. Admins read the log, so a private or
 * shared view (which they only see as metadata) keeps the metadata alone:
 * no panel count or version, which hint at its content and history.
 */
function auditFields(row: { title: string; scopeType: string; scopeId: string | null; version: number; visibility: string }, spec: ViewSpec) {
    const base = { title: row.title, scopeType: row.scopeType, scopeId: row.scopeId };
    return row.visibility === "scope" ? { ...base, panelCount: spec.panels.length, version: row.version } : base;
}

// ─── Realtime ────────────────────────────────────────────────────────────────

type AnnounceState = { lastAt: number; timer: ReturnType<typeof setTimeout> | null };
const announceStates = new Map<string, AnnounceState>();

/**
 * Send one view_updated (ids only, never values). A 'scope' view goes to the
 * company (realtime-delivery keeps it from sockets scoped away from its
 * customer/project); a private or shared one only to the people with full
 * access, one personal event each, so nobody else even learns it changed.
 * The view is read at send time, so a trailing send uses its current state.
 */
async function deliverViewUpdated(companyId: string, viewId: string): Promise<void> {
    const [row] = await db.select().from(views).where(and(eq(views.companyId, companyId), eq(views.id, viewId))).limit(1);
    if (!row) return;
    const payload: Record<string, unknown> = { type: "view_updated", viewId: row.id };
    if (row.visibility === "scope") {
        if (row.scopeType === "project") payload.projectId = row.scopeId;
        if (row.scopeType === "customer") payload.customerId = row.scopeId;
        await broadcastMcpEvent(companyId, payload);
        return;
    }
    for (const userId of await fullAccessPeople(companyId, row)) {
        await broadcastUserEvent(companyId, userId, payload as { type: string });
    }
}

/** The people who fully see a private/shared view (owner and shares, each still inside the scope). */
async function fullAccessPeople(companyId: string, row: ViewRow): Promise<string[]> {
    const shared = row.visibility === "shared" ? (await sharesOf([row.id])).get(row.id) ?? [] : [];
    const candidates = [...new Set([row.ownerUserId, ...shared].filter((id): id is string => Boolean(id)))];
    const people = await Promise.all(candidates.map((id) => personInScope(companyId, id, row)));
    return people.filter((p): p is NonNullable<typeof p> => Boolean(p)).map((p) => p.userId);
}

/**
 * Tell open pages. Coalesced per view: at most one broadcast per
 * VIEW_ANNOUNCE_INTERVAL_MS, the last one trailing, so an agent pushing many
 * panels triggers one page refresh.
 */
function announce(companyId: string, row: { id: string }) {
    const send = () => { Promise.resolve(deliverViewUpdated(companyId, row.id)).catch(() => {}); };
    const key = `${companyId}:${row.id}`;
    const now = Date.now();
    const state = announceStates.get(key);
    if (!state || (!state.timer && now - state.lastAt >= VIEW_ANNOUNCE_INTERVAL_MS)) {
        if (announceStates.size > 1000) {
            for (const [k, s] of announceStates) if (!s.timer && now - s.lastAt >= VIEW_ANNOUNCE_INTERVAL_MS) announceStates.delete(k);
        }
        announceStates.set(key, { lastAt: now, timer: null });
        send();
        return;
    }
    if (state.timer) return;
    state.timer = setTimeout(() => {
        state.timer = null;
        state.lastAt = Date.now();
        send();
    }, Math.max(VIEW_ANNOUNCE_INTERVAL_MS - (now - state.lastAt), 0));
    state.timer.unref?.();
}

// ─── Reads ───────────────────────────────────────────────────────────────────

type Named = { id: string; name: string | null };

export type ViewSummary = {
    id: string;
    title: string;
    /** "metadata": an admin outside a private/shared view; content fields are empty. */
    access: Exclude<ViewAccess, "none">;
    description: string | null;
    scopeType: ViewScopeType;
    scopeId: string | null;
    scopeLabel: string | null;
    /** The customer a customer view or a project view's project belongs to (grouping). */
    customerId: string | null;
    customerLabel: string | null;
    visibility: ViewVisibility;
    owner: Named | null;
    /** People it is shared with (shared views, full access only). */
    sharedCount: number | null;
    /** On the caller's own Home (people only). */
    pinned: boolean;
    panelCount: number;
    version: number;
    archived: boolean;
    createdBy: { type: string; id: string | null; name: string | null };
    refreshEveryMinutes: number | null;
    createdAt: string;
    updatedAt: string;
    /** When the newest panel value arrived (null when no panel has data yet). */
    dataUpdatedAt: string | null;
    /** The first metric panel with a value, for list rows. */
    keyMetric: { title: string; data: MetricPanelData } | null;
};

type NameMaps = { agents: Map<string, string>; users: Map<string, string> };

async function loadNames(agentIds: string[], userIds: string[]): Promise<NameMaps> {
    const a = [...new Set(agentIds.filter((id) => UUID_RE.test(id)))];
    const u = [...new Set(userIds.filter((id) => UUID_RE.test(id)))];
    const [agentRows, userRows] = await Promise.all([
        a.length ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, a)) : Promise.resolve([]),
        u.length ? db.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, u)) : Promise.resolve([]),
    ]);
    return {
        agents: new Map(agentRows.map((r) => [r.id, r.name])),
        users: new Map(userRows.map((r) => [r.id, r.name || r.email.split("@")[0]])),
    };
}

function nameOf(names: NameMaps, type: string, id: string | null): string | null {
    if (!id) return type === "system" ? "System" : null;
    return type === "agent" ? names.agents.get(id) ?? null : type === "human" ? names.users.get(id) ?? null : null;
}

type ScopeInfo = { label: string; customerId: string | null; customerLabel: string | null };

async function scopeInfo(companyId: string, rows: { scopeType: string; scopeId: string | null }[]): Promise<Map<string, ScopeInfo>> {
    const projectIds = [...new Set(rows.filter((r) => r.scopeType === "project" && r.scopeId).map((r) => r.scopeId!))];
    const p = projectIds.length ? await db.select({ id: projects.id, goal: projects.goal, customerId: projects.customerId }).from(projects)
        .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds))) : [];
    const customerIds = [...new Set([
        ...rows.filter((r) => r.scopeType === "customer" && r.scopeId).map((r) => r.scopeId!),
        ...p.map((r) => r.customerId).filter((id): id is string => Boolean(id)),
    ])];
    const c = customerIds.length ? await db.select({ id: customers.id, name: customers.name }).from(customers)
        .where(and(eq(customers.companyId, companyId), inArray(customers.id, customerIds))) : [];
    const customerName = new Map(c.map((r) => [r.id, r.name]));
    const { splitProjectTitle } = await import("@/lib/project-title");
    return new Map<string, ScopeInfo>([
        ...c.map((r) => [r.id, { label: r.name, customerId: r.id, customerLabel: r.name }] as [string, ScopeInfo]),
        ...p.map((r) => [r.id, {
            label: splitProjectTitle(r.goal).name,
            customerId: r.customerId,
            customerLabel: r.customerId ? customerName.get(r.customerId) ?? null : null,
        }] as [string, ScopeInfo]),
    ]);
}

async function myPins(companyId: string, caller: ViewCaller, viewIds: string[]): Promise<Map<string, number>> {
    if (caller.kind !== "member" || viewIds.length === 0) return new Map();
    const rows = await db.select({ viewId: viewPins.viewId, position: viewPins.position }).from(viewPins)
        .where(and(eq(viewPins.companyId, companyId), eq(viewPins.userId, caller.userId), inArray(viewPins.viewId, viewIds)));
    return new Map(rows.map((r) => [r.viewId, r.position]));
}

/** The first metric panel of each view that has a value (values of metric panels only: other panels can be large). */
async function keyMetrics(companyId: string, rows: ViewRow[]): Promise<Map<string, { title: string; data: MetricPanelData }>> {
    const wanted = rows.map((row) => ({ viewId: row.id, panels: storedViewSpec(row.specJson).panels.filter((p) => p.type === "metric") }))
        .filter((w) => w.panels.length > 0);
    if (wanted.length === 0) return new Map();
    const dataRows = await db.select({ viewId: viewPanelData.viewId, panelId: viewPanelData.panelId, dataJson: viewPanelData.dataJson })
        .from(viewPanelData).where(and(
            eq(viewPanelData.companyId, companyId),
            or(...wanted.map((w) => and(eq(viewPanelData.viewId, w.viewId), inArray(viewPanelData.panelId, w.panels.map((p) => p.id))))),
        ));
    const dataOf = new Map(dataRows.map((row) => [`${row.viewId}:${row.panelId}`, row.dataJson]));
    const out = new Map<string, { title: string; data: MetricPanelData }>();
    for (const w of wanted) {
        for (const panel of w.panels) {
            const data = storedPanelData("metric", dataOf.get(`${w.viewId}:${panel.id}`));
            if (data) { out.set(w.viewId, { title: panel.title, data: data as MetricPanelData }); break; }
        }
    }
    return out;
}

export async function listViews(companyId: string, caller: ViewCaller, options: {
    scopeType?: ViewScopeType;
    scopeId?: string;
    /** A customer's views plus the views of its projects. */
    customerTree?: string;
    includeArchived?: boolean;
    /** Only the caller's Home pins, in pin order. */
    pinnedOnly?: boolean;
    limit?: number;
} = {}): Promise<ViewSummary[]> {
    if (options.pinnedOnly && caller.kind !== "member") return [];
    const condition = await readCondition(companyId, caller);
    const tree = options.customerTree && UUID_RE.test(options.customerTree) ? options.customerTree : null;
    const rows = await db.select().from(views).where(and(
        eq(views.companyId, companyId),
        options.includeArchived ? undefined : isNull(views.archivedAt),
        options.pinnedOnly && caller.kind === "member" ? exists(db.select({ one: sql`1` }).from(viewPins)
            .where(and(eq(viewPins.viewId, views.id), eq(viewPins.userId, caller.userId)))) : undefined,
        options.scopeType ? eq(views.scopeType, options.scopeType) : undefined,
        options.scopeId && UUID_RE.test(options.scopeId) ? eq(views.scopeId, options.scopeId) : undefined,
        tree ? or(
            and(eq(views.scopeType, "customer"), eq(views.scopeId, tree)),
            and(eq(views.scopeType, "project"), inArray(views.scopeId,
                db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, companyId), eq(projects.customerId, tree))))),
        ) : undefined,
        condition,
    )).orderBy(desc(views.updatedAt)).limit(Math.min(Math.max(options.limit ?? 200, 1), 500));
    if (rows.length === 0) return [];

    const accessById = await accessChecker(companyId, caller, rows);
    const visible = rows.filter((row) => {
        const access = accessById.get(row.id) ?? "none";
        // Pins are for views the person can open.
        return options.pinnedOnly ? access === "full" : access !== "none";
    });
    if (visible.length === 0) return [];
    const full = visible.filter((row) => accessById.get(row.id) === "full");
    const ids = visible.map((r) => r.id);
    const fullIds = full.map((r) => r.id);
    const [freshness, scopes, names, pins, metrics, shares] = await Promise.all([
        fullIds.length ? db.select({ viewId: viewPanelData.viewId, at: sql<Date>`max(${viewPanelData.updatedAt})` })
            .from(viewPanelData).where(and(eq(viewPanelData.companyId, companyId), inArray(viewPanelData.viewId, fullIds)))
            .groupBy(viewPanelData.viewId) : Promise.resolve([]),
        scopeInfo(companyId, visible),
        loadNames(visible.filter((r) => r.createdByType === "agent" && r.createdById).map((r) => r.createdById!),
            [...visible.filter((r) => r.createdByType === "human" && r.createdById).map((r) => r.createdById!),
                ...visible.map((r) => r.ownerUserId).filter((id): id is string => Boolean(id))]),
        myPins(companyId, caller, ids),
        keyMetrics(companyId, full),
        sharesOf(full.filter((r) => r.visibility === "shared").map((r) => r.id)),
    ]);
    const freshBy = new Map(freshness.map((f) => [f.viewId, f.at ? new Date(f.at).toISOString() : null]));
    const summaries = visible.map((row): ViewSummary => {
        const access = accessById.get(row.id) === "full" ? "full" : "metadata";
        const info = row.scopeId ? scopes.get(row.scopeId) : undefined;
        const metadata = access === "metadata";
        return {
            id: row.id,
            title: row.title,
            access,
            description: metadata ? null : row.description,
            scopeType: row.scopeType as ViewScopeType,
            scopeId: row.scopeId,
            scopeLabel: info?.label ?? null,
            customerId: info?.customerId ?? null,
            customerLabel: info?.customerLabel ?? null,
            visibility: row.visibility as ViewVisibility,
            owner: row.ownerUserId ? { id: row.ownerUserId, name: names.users.get(row.ownerUserId) ?? null } : null,
            sharedCount: metadata || row.visibility !== "shared" ? null : (shares.get(row.id) ?? []).length,
            pinned: pins.has(row.id),
            panelCount: metadata ? 0 : storedViewSpec(row.specJson).panels.length,
            version: metadata ? 0 : row.version,
            archived: Boolean(row.archivedAt),
            createdBy: { type: row.createdByType, id: row.createdById, name: nameOf(names, row.createdByType, row.createdById) },
            refreshEveryMinutes: metadata ? null : row.refreshEveryMinutes,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            dataUpdatedAt: metadata ? null : freshBy.get(row.id) ?? null,
            keyMetric: metadata ? null : metrics.get(row.id) ?? null,
        };
    });
    if (options.pinnedOnly) summaries.sort((a, b) => (pins.get(a.id) ?? 0) - (pins.get(b.id) ?? 0));
    return summaries;
}

export type ViewPanel = ViewPanelLayout & {
    data: ViewPanelData | null;
    updatedAt: string | null;
    updatedBy: { type: string; id: string | null; name: string | null } | null;
};

export type ViewDetail = Omit<ViewSummary, "panelCount" | "dataUpdatedAt" | "keyMetric"> & {
    panels: ViewPanel[];
    updatedBy: { type: string; id: string | null; name: string | null };
    /** The people it is shared with: shown to its owner only (null otherwise). */
    sharedWith: Named[] | null;
};

/**
 * One view. A metadata-only caller (an admin outside a private/shared view)
 * gets title, owner, maintainer, scope and times, with no panels, values,
 * description or history; pass `allowMetadata` where that is wanted (the page
 * and the human GET). Everyone else outside it gets ViewNotFoundError.
 */
export async function getView(
    companyId: string, caller: ViewCaller, viewId: string,
    options: { includeArchived?: boolean; allowMetadata?: boolean } = {},
): Promise<ViewDetail> {
    const { row, access } = await loadVisibleView(companyId, caller, viewId, { includeArchived: options.includeArchived, need: options.allowMetadata ? "metadata" : "full" });
    const metadata = access === "metadata";
    // A company-wide token naming ?agentId= acts as that agent without being
    // bound to it, so the agent rule rests on who holds the token: leave a
    // trace when one opens a private or shared view.
    if (caller.kind === "agent" && !caller.access.bound && row.visibility !== "scope" && firstUnboundReadToday(row.id, actorOf(caller).id)) {
        await recordAudit({
            companyId, actor: actorOf(caller), action: "view.read_unbound_token", target: { type: "view", id: row.id },
            meta: { label: row.title, visibility: row.visibility },
        });
    }
    const spec = storedViewSpec(row.specJson);
    const dataRows = metadata ? [] : await db.select().from(viewPanelData)
        .where(and(eq(viewPanelData.companyId, companyId), eq(viewPanelData.viewId, row.id)));
    const byPanel = new Map(dataRows.map((d) => [d.panelId, d]));
    const shared = !metadata && row.visibility === "shared" ? (await sharesOf([row.id])).get(row.id) ?? [] : [];
    const isOwner = caller.kind === "member" && row.ownerUserId === caller.userId;
    const people = [row.createdByType === "human" ? row.createdById : null, row.updatedByType === "human" ? row.updatedById : null, row.ownerUserId,
        ...(isOwner ? shared : []),
        ...dataRows.filter((d) => d.updatedByType === "human").map((d) => d.updatedById)].filter((id): id is string => Boolean(id));
    const bots = [row.createdByType === "agent" ? row.createdById : null, row.updatedByType === "agent" ? row.updatedById : null,
        ...dataRows.filter((d) => d.updatedByType === "agent").map((d) => d.updatedById)].filter((id): id is string => Boolean(id));
    const [names, scopes, pins] = await Promise.all([loadNames(bots, people), scopeInfo(companyId, [row]), myPins(companyId, caller, [row.id])]);
    const info = row.scopeId ? scopes.get(row.scopeId) : undefined;
    return {
        id: row.id,
        title: row.title,
        access,
        description: metadata ? null : row.description,
        scopeType: row.scopeType as ViewScopeType,
        scopeId: row.scopeId,
        scopeLabel: info?.label ?? null,
        customerId: info?.customerId ?? null,
        customerLabel: info?.customerLabel ?? null,
        visibility: row.visibility as ViewVisibility,
        owner: row.ownerUserId ? { id: row.ownerUserId, name: names.users.get(row.ownerUserId) ?? null } : null,
        sharedCount: metadata || row.visibility !== "shared" ? null : shared.length,
        sharedWith: isOwner && !metadata ? shared.map((id) => ({ id, name: names.users.get(id) ?? null })) : null,
        pinned: pins.has(row.id),
        version: metadata ? 0 : row.version,
        archived: Boolean(row.archivedAt),
        createdBy: { type: row.createdByType, id: row.createdById, name: nameOf(names, row.createdByType, row.createdById) },
        updatedBy: metadata
            ? { type: row.createdByType, id: null, name: null }
            : { type: row.updatedByType, id: row.updatedById, name: nameOf(names, row.updatedByType, row.updatedById) },
        refreshEveryMinutes: metadata ? null : row.refreshEveryMinutes,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        panels: metadata ? [] : spec.panels.map((panel) => {
            const stored = byPanel.get(panel.id);
            return {
                ...panel,
                data: stored ? storedPanelData(panel.type, stored.dataJson) : null,
                updatedAt: stored ? stored.updatedAt.toISOString() : null,
                updatedBy: stored ? { type: stored.updatedByType, id: stored.updatedById, name: nameOf(names, stored.updatedByType, stored.updatedById) } : null,
            };
        }),
    };
}

export type ViewVersionSummary = {
    version: number;
    title: string;
    panelCount: number;
    author: { type: string; id: string | null; name: string | null };
    createdAt: string;
    current: boolean;
};

export async function listViewVersions(companyId: string, caller: ViewCaller, viewId: string): Promise<ViewVersionSummary[]> {
    const { row } = await loadVisibleView(companyId, caller, viewId, { includeArchived: true });
    const versions = await db.select().from(viewVersions)
        .where(and(eq(viewVersions.companyId, companyId), eq(viewVersions.viewId, row.id)))
        .orderBy(desc(viewVersions.version)).limit(VIEW_VERSIONS_KEPT);
    const names = await loadNames(versions.filter((v) => v.authorType === "agent" && v.authorId).map((v) => v.authorId!),
        versions.filter((v) => v.authorType === "human" && v.authorId).map((v) => v.authorId!));
    return versions.map((v) => ({
        version: v.version,
        title: v.title,
        panelCount: storedViewSpec(v.specJson).panels.length,
        author: { type: v.authorType, id: v.authorId, name: nameOf(names, v.authorType, v.authorId) },
        createdAt: v.createdAt.toISOString(),
        current: v.version === row.version,
    }));
}

/** Company members (not deleted) who can see this scope, except `exclude`. */
async function membersInScope(companyId: string, scope: { scopeType: string; scopeId: string | null }, exclude: readonly (string | null)[]): Promise<Named[]> {
    const members = await db.select({ userId: companyMembers.userId, role: companyMembers.role, scopeJson: companyMembers.scopeJson, instanceRole: users.instanceRole, name: users.displayName, email: users.email })
        .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
        .where(and(eq(companyMembers.companyId, companyId), isNull(users.deletedAt))).orderBy(asc(users.displayName)).limit(500);
    const out: Named[] = [];
    for (const m of members) {
        if (exclude.includes(m.userId)) continue;
        const unrestricted = m.role === "owner" || m.role === "admin" || m.instanceRole === "instance_admin";
        if (await memberMaySeeResource(companyId, unrestricted ? null : await resolveMemberScope(companyId, m.userId, m.scopeJson), scope)) {
            out.push({ id: m.userId, name: m.name || m.email.split("@")[0] });
        }
    }
    return out;
}

/** People a view's owner may share it with: company members who can see its scope (owner excluded). */
export async function listViewSharePeople(companyId: string, caller: ViewCaller, viewId: string): Promise<Named[]> {
    const { row } = await loadVisibleView(companyId, caller, viewId, { includeArchived: true });
    if (caller.kind !== "member" || row.ownerUserId !== caller.userId) return [];
    return membersInScope(companyId, row, [row.ownerUserId]);
}

/**
 * People this caller may hand a view to: members who can see its scope, not
 * its current owner, and not the caller unless they can already open it (an
 * admin with metadata access must never give it to themselves).
 */
export async function listViewTransferPeople(companyId: string, caller: ViewCaller, viewId: string): Promise<Named[]> {
    if (caller.kind !== "member") return [];
    const { row, access } = await loadVisibleView(companyId, caller, viewId, { includeArchived: true, need: "metadata" });
    if (!isAdminRole(caller.role) && row.ownerUserId !== caller.userId) return [];
    return membersInScope(companyId, row, [row.ownerUserId, ...(access === "full" ? [] : [caller.userId])]);
}

// ─── Writes ──────────────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function upsertPanelData(tx: Tx, companyId: string, viewId: string, entries: Record<string, ViewPanelData>, by: { type: string; id: string | null }, now: Date) {
    const values = Object.entries(entries).map(([panelId, data]) => ({
        companyId, viewId, panelId, dataJson: data, updatedByType: by.type, updatedById: by.id, updatedAt: now,
    }));
    if (values.length === 0) return;
    await tx.insert(viewPanelData).values(values).onConflictDoUpdate({
        target: [viewPanelData.viewId, viewPanelData.panelId],
        set: { dataJson: sql`excluded.data_json`, updatedByType: sql`excluded.updated_by_type`, updatedById: sql`excluded.updated_by_id`, updatedAt: sql`excluded.updated_at` },
    });
}

async function writeVersion(tx: Tx, companyId: string, viewId: string, version: number, title: string, spec: ViewSpec, by: { type: string; id: string | null }, now: Date) {
    await tx.insert(viewVersions).values({ companyId, viewId, version, title, specJson: spec, authorType: by.type, authorId: by.id, createdAt: now });
    if (version > VIEW_VERSIONS_KEPT) {
        await tx.delete(viewVersions).where(and(eq(viewVersions.viewId, viewId), sql`${viewVersions.version} <= ${version - VIEW_VERSIONS_KEPT}`));
    }
}

function totalDataError(bytes: number): string | null {
    return bytes > VIEW_TOTAL_DATA_MAX_BYTES ? `The view's panel data would be ${Math.ceil(bytes / 1024)} KB; the limit is ${VIEW_TOTAL_DATA_MAX_BYTES / 1024} KB` : null;
}

/**
 * The person an agent is building a view for, from the conversation it is
 * answering. A private direct thread with this agent names its owner; in any
 * other thread the agent works in, an explicit ownerUserId must be a person
 * of that thread (a participant or someone who wrote in it). Without a
 * thread, an agent cannot name an owner.
 */
async function resolveAgentOwner(companyId: string, agentId: string | null, input: { threadId?: unknown; ownerUserId?: unknown }): Promise<{ ownerUserId: string | null; source: "private_thread" | "conversation" | "none" }> {
    const explicit = typeof input.ownerUserId === "string" && input.ownerUserId.trim() ? input.ownerUserId.trim() : null;
    const threadId = typeof input.threadId === "string" && input.threadId.trim() ? input.threadId.trim() : null;
    if (!threadId) {
        if (explicit) throw new ViewInputError("ownerUserId needs the threadId of the conversation you are answering, so Emperor can check that person asked");
        return { ownerUserId: null, source: "none" };
    }
    const notFound = new ViewInputError("threadId is not a conversation you are part of");
    if (!agentId || !UUID_RE.test(threadId)) {
        if (explicit) throw notFound;
        return { ownerUserId: null, source: "none" };
    }
    const [thread] = await db.select().from(messageThreads).where(and(eq(messageThreads.companyId, companyId), eq(messageThreads.id, threadId))).limit(1);
    if (!thread) throw notFound;
    const privateDirect = thread.type === "direct" && (thread.isPrivate || Boolean(thread.ownerUserId));
    // A team, group or shared thread names nobody by itself: without an
    // explicit owner there is nothing to check (the Hermes plugin sends the
    // turn's thread on every create_view).
    if (!privateDirect && !explicit) return { ownerUserId: null, source: "none" };
    if (privateDirect) {
        // Another agent's private chat is not this agent's business.
        if (thread.directAgentId !== agentId) throw notFound;
        const picked = pickViewOwner({ explicit, derived: thread.ownerUserId, candidates: [] });
        if (!picked.ok) throw new ViewInputError(picked.error);
        return { ownerUserId: picked.ownerUserId, source: picked.ownerUserId ? "private_thread" : "none" };
    }
    const related = thread.directAgentId === agentId
        || (await db.select({ id: threadParticipants.id }).from(threadParticipants).where(and(
            eq(threadParticipants.threadId, thread.id), eq(threadParticipants.participantType, "agent"), eq(threadParticipants.participantId, agentId),
        )).limit(1)).length > 0
        || (await db.select({ id: threadMessages.id }).from(threadMessages).where(and(
            eq(threadMessages.threadId, thread.id),
            or(and(eq(threadMessages.senderType, "agent"), eq(threadMessages.senderId, agentId)), eq(threadMessages.targetAgentId, agentId)),
        )).limit(1)).length > 0;
    if (!related) throw notFound;
    const [participants, senders] = await Promise.all([
        db.select({ ref: threadParticipants.participantRef }).from(threadParticipants)
            .where(and(eq(threadParticipants.threadId, thread.id), eq(threadParticipants.participantType, "human"))),
        db.selectDistinct({ id: threadMessages.senderId }).from(threadMessages)
            .where(and(eq(threadMessages.threadId, thread.id), eq(threadMessages.senderType, "human"))),
    ]);
    const candidates = [...participants.map((p) => p.ref), ...senders.map((s) => s.id)].filter((id): id is string => Boolean(id));
    const picked = pickViewOwner({ explicit, derived: null, candidates });
    if (!picked.ok) throw new ViewInputError(picked.error);
    return { ownerUserId: picked.ownerUserId, source: "conversation" };
}

function parseVisibility(value: unknown, allowed: readonly string[]): ViewVisibility | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !allowed.includes(value)) {
        throw new ViewInputError(allowed.length === 2
            ? "visibility must be private or scope (sharing with specific people is done by a person in Emperor)"
            : `visibility must be one of: ${allowed.join(", ")}`);
    }
    return value as ViewVisibility;
}

export type CreateViewInput = {
    title: unknown;
    description?: unknown;
    scopeType?: unknown;
    scopeId?: unknown;
    panels?: unknown;
    visibility?: unknown;
    /** Agents: the person the view is for (validated against threadId). */
    ownerUserId?: unknown;
    /** Agents: the conversation the request came from. */
    threadId?: unknown;
    refreshEveryMinutes?: unknown;
};

export async function createView(companyId: string, caller: ViewCaller, input: CreateViewInput): Promise<ViewDetail> {
    const title = parseViewTitle(input.title);
    if (!title.ok) throw new ViewInputError(title.error);
    const description = parseViewDescription(input.description);
    if (!description.ok) throw new ViewInputError(description.error);
    const panels = parseViewPanels(input.panels ?? []);
    if (!panels.ok) throw new ViewInputError(`Invalid view: ${panels.error}`);
    const dataError = totalDataError(jsonBytes(Object.values(panels.value.data)));
    if (dataError) throw new ViewInputError(dataError);
    const refresh = parseRefreshEveryMinutes(input.refreshEveryMinutes);
    if (!refresh.ok) throw new ViewInputError(refresh.error);
    const scope = await checkWritableScope(companyId, caller, input.scopeType, input.scopeId);

    // Owner and visibility. People own what they create; agents own nothing,
    // they build for the person whose conversation they are answering.
    let ownerUserId: string | null;
    let visibility: ViewVisibility;
    let ownerSource: "person" | "private_thread" | "conversation" | "none" = "person";
    if (caller.kind === "member") {
        ownerUserId = caller.userId;
        visibility = parseVisibility(input.visibility, ["private", "scope"]) ?? defaultViewVisibility({ ownerUserId, source: "person" });
    } else {
        const resolved = await resolveAgentOwner(companyId, caller.access.agentId, input);
        ownerUserId = resolved.ownerUserId;
        ownerSource = resolved.source;
        if (ownerUserId && !(await personInScope(companyId, ownerUserId, scope))) {
            throw new ViewInputError("That person cannot see this scope; file the view under a scope they can see");
        }
        const asked = parseVisibility(input.visibility, AGENT_VIEW_VISIBILITIES);
        // Made in a person's private chat: it starts private. Opening it up is its owner's call, in Emperor.
        if (resolved.source === "private_thread" && asked === "scope") {
            throw new ViewInputError("A view made in a person's private chat starts private; its owner can open it to the scope in Emperor");
        }
        visibility = asked ?? defaultViewVisibility({ ownerUserId, source: resolved.source });
    }
    if (visibility !== "scope" && !ownerUserId) {
        throw new ViewInputError("A private view needs the person it is for: pass the threadId of their private chat with you");
    }

    const [{ active }] = await db.select({ active: sql<number>`count(*)`.mapWith(Number) }).from(views)
        .where(and(eq(views.companyId, companyId), isNull(views.archivedAt)));
    if (active >= VIEW_MAX_ACTIVE_PER_COMPANY) {
        throw new ViewRefusedError(`This company already has ${VIEW_MAX_ACTIVE_PER_COMPANY} views, the limit. Update an existing view (list_views) or archive one that is no longer needed.`, 409);
    }
    const by = stamp(caller);
    const now = new Date();

    const row = await db.transaction(async (tx) => {
        const [created] = await tx.insert(views).values({
            companyId, title: title.value, description: description.value, scopeType: scope.scopeType, scopeId: scope.scopeId,
            specJson: panels.value.spec, version: 1, ownerUserId, visibility, refreshEveryMinutes: refresh.value ?? null,
            createdByType: by.type, createdById: by.id, updatedByType: by.type, updatedById: by.id, createdAt: now, updatedAt: now,
        }).returning();
        await writeVersion(tx, companyId, created.id, 1, created.title, panels.value.spec, by, now);
        await upsertPanelData(tx, companyId, created.id, panels.value.data, by, now);
        return created;
    });

    await recordAudit({
        companyId, actor: actorOf(caller), action: "view.created", target: { type: "view", id: row.id },
        after: { ...auditFields(row, panels.value.spec), visibility, ownerUserId },
        // Where an agent's owner came from (and which thread), so a named owner can be traced.
        meta: { label: row.title, ...(caller.kind === "agent" ? { ownerSource, threadId: typeof input.threadId === "string" ? input.threadId : null } : {}) },
    });
    announce(companyId, row);
    return getView(companyId, caller, row.id);
}

export type UpdateViewInput = {
    title?: unknown;
    description?: unknown;
    panels?: unknown;
    refreshEveryMinutes?: unknown;
};

/**
 * Change a view's title, description, refresh interval and/or layout. A title
 * or layout change writes a new version; panels sent with `data` also refresh
 * those values. Values of panels the new layout drops are deleted.
 */
export async function updateView(
    companyId: string, caller: ViewCaller, viewId: string, input: UpdateViewInput,
    options: { revertedFrom?: number } = {},
): Promise<ViewDetail> {
    const { row: existing } = await loadVisibleView(companyId, caller, viewId);
    assertMayWrite(caller, existing);
    const title = input.title === undefined ? null : parseViewTitle(input.title);
    if (title && !title.ok) throw new ViewInputError(title.error);
    const description = input.description === undefined ? null : parseViewDescription(input.description);
    if (description && !description.ok) throw new ViewInputError(description.error);
    const panels = input.panels === undefined ? null : parseViewPanels(input.panels);
    if (panels && !panels.ok) throw new ViewInputError(`Invalid view: ${panels.error}`);
    const refresh = parseRefreshEveryMinutes(input.refreshEveryMinutes);
    if (!refresh.ok) throw new ViewInputError(refresh.error);
    const by = stamp(caller);
    const now = new Date();

    const result = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(views).where(and(eq(views.id, existing.id), eq(views.companyId, companyId))).for("update");
        if (!current || current.archivedAt) throw new ViewNotFoundError();
        const currentSpec = storedViewSpec(current.specJson);
        const plan = planViewVersion(
            { title: current.title, spec: currentSpec, version: current.version },
            { title: title?.ok ? title.value : undefined, spec: panels?.ok ? panels.value.spec : undefined },
        );
        const nextDescription = description?.ok ? description.value : current.description;
        const nextRefresh = refresh.value === undefined ? current.refreshEveryMinutes : refresh.value;
        const newData = panels?.ok ? panels.value.data : {};
        const descriptionChanged = nextDescription !== current.description;
        const refreshChanged = nextRefresh !== current.refreshEveryMinutes;
        if (!plan.changed && !descriptionChanged && !refreshChanged && Object.keys(newData).length === 0) return { row: current, plan, spec: currentSpec, changed: false };

        if (panels?.ok) {
            const keep = plan.spec.panels.map((p) => p.id);
            // Values of panels that left the layout go with them.
            await tx.delete(viewPanelData).where(and(eq(viewPanelData.viewId, current.id), keep.length ? notInArray(viewPanelData.panelId, keep) : undefined));
            // A panel whose type changed keeps no values of the old shape.
            const typeOf = new Map(currentSpec.panels.map((p) => [p.id, p.type]));
            const retyped = plan.spec.panels.filter((p) => typeOf.has(p.id) && typeOf.get(p.id) !== p.type).map((p) => p.id);
            if (retyped.length) await tx.delete(viewPanelData).where(and(eq(viewPanelData.viewId, current.id), inArray(viewPanelData.panelId, retyped)));
            await upsertPanelData(tx, companyId, current.id, newData, by, now);
            const [{ bytes }] = await tx.select({ bytes: sql<number>`COALESCE(SUM(octet_length(${viewPanelData.dataJson}::text)), 0)`.mapWith(Number) })
                .from(viewPanelData).where(eq(viewPanelData.viewId, current.id));
            const tooBig = totalDataError(bytes);
            if (tooBig) throw new ViewInputError(tooBig);
        }
        const [row] = await tx.update(views).set({
            title: plan.title, description: nextDescription, specJson: plan.spec, version: plan.version, refreshEveryMinutes: nextRefresh,
            updatedByType: by.type, updatedById: by.id, updatedAt: now,
        }).where(eq(views.id, current.id)).returning();
        if (plan.changed) await writeVersion(tx, companyId, row.id, plan.version, plan.title, plan.spec, by, now);
        return { row, plan, spec: currentSpec, changed: true };
    });

    if (result.changed) {
        if (result.plan.changed) {
            const before = auditFields({ ...result.row, title: existing.title, version: existing.version }, result.spec);
            const after = auditFields(result.row, result.plan.spec);
            await recordAudit({
                companyId, actor: actorOf(caller), action: options.revertedFrom ? "view.reverted" : "view.updated", target: { type: "view", id: result.row.id },
                before, after, meta: { label: result.row.title, ...(options.revertedFrom ? { fromVersion: options.revertedFrom } : {}) },
            });
        }
        announce(companyId, result.row);
    }
    return getView(companyId, caller, result.row.id);
}

/** Replace one panel's values. Validated against the panel's type; never versions or audits (values only). */
export async function updatePanel(companyId: string, caller: ViewCaller, viewId: string, panelId: unknown, data: unknown): Promise<ViewPanel> {
    const { row } = await loadVisibleView(companyId, caller, viewId);
    assertMayWrite(caller, row);
    const spec = storedViewSpec(row.specJson);
    const panel = typeof panelId === "string" ? spec.panels.find((p) => p.id === panelId.trim()) : undefined;
    if (!panel) throw new ViewInputError(`Panel not found. This view's panels: ${spec.panels.map((p) => `${p.id} (${p.type})`).join(", ") || "none"}`);
    const parsed = parsePanelData(panel.type, data);
    if (!parsed.ok) throw new ViewInputError(`Invalid ${panel.type} panel: ${parsed.error}`);
    const by = stamp(caller);
    const actor = actorOf(caller);
    const limit = consumeRateLimit({
        key: `views:update_panel:${row.id}:${actor.type}:${actor.id ?? `token:${actor.tokenId ?? "none"}`}`,
        limit: VIEW_PANEL_UPDATES_PER_MINUTE,
        windowMs: 60_000,
    });
    if (!limit.allowed) {
        throw new ViewRefusedError(`Too many panel updates for this view: at most ${VIEW_PANEL_UPDATES_PER_MINUTE} a minute. Refresh each panel once per run and slow your schedule.`, 429);
    }
    const now = new Date();

    await db.transaction(async (tx) => {
        // Hold the layout still (update_view takes FOR UPDATE) so a value never lands on a panel that was just removed or retyped.
        const [locked] = await tx.select({ specJson: views.specJson, archivedAt: views.archivedAt }).from(views)
            .where(and(eq(views.id, row.id), eq(views.companyId, companyId))).for("share");
        const still = locked && !locked.archivedAt ? storedViewSpec(locked.specJson).panels.find((p) => p.id === panel.id) : undefined;
        if (!locked || locked.archivedAt) throw new ViewNotFoundError();
        if (!still || still.type !== panel.type) throw new ViewInputError("The view's layout changed; call get_view and try again");
        const [{ bytes }] = await tx.select({ bytes: sql<number>`COALESCE(SUM(octet_length(${viewPanelData.dataJson}::text)), 0)`.mapWith(Number) })
            .from(viewPanelData).where(and(eq(viewPanelData.viewId, row.id), ne(viewPanelData.panelId, panel.id)));
        const tooBig = totalDataError(bytes + jsonBytes(parsed.value));
        if (tooBig) throw new ViewInputError(tooBig);
        await upsertPanelData(tx, companyId, row.id, { [panel.id]: parsed.value }, by, now);
    });
    announce(companyId, row);
    const names = await loadNames(by.type === "agent" && by.id ? [by.id] : [], by.type === "human" && by.id ? [by.id] : []);
    return { ...panel, data: parsed.value, updatedAt: now.toISOString(), updatedBy: { type: by.type, id: by.id, name: nameOf(names, by.type, by.id) } };
}

/** Archive (hide) a view, or restore an archived one. Archived views keep their versions and values; archiving clears every Home pin. */
export async function setViewArchived(companyId: string, caller: ViewCaller, viewId: string, archived: boolean): Promise<{ id: string; archived: boolean }> {
    const { row } = await loadVisibleView(companyId, caller, viewId, { includeArchived: true });
    assertMayWrite(caller, row);
    if (Boolean(row.archivedAt) === archived) return { id: row.id, archived };
    const by = stamp(caller);
    const [updated] = await db.update(views).set({
        archivedAt: archived ? new Date() : null,
        updatedByType: by.type, updatedById: by.id, updatedAt: new Date(),
    }).where(and(eq(views.id, row.id), eq(views.companyId, companyId), archived ? isNull(views.archivedAt) : isNotNull(views.archivedAt))).returning();
    if (updated) {
        // An archived view leaves everyone's Home.
        if (archived) await db.delete(viewPins).where(and(eq(viewPins.companyId, companyId), eq(viewPins.viewId, row.id)));
        await recordAudit({
            companyId, actor: actorOf(caller), action: archived ? "view.archived" : "view.restored", target: { type: "view", id: row.id },
            before: { archived: !archived }, after: { archived }, meta: { label: row.title },
        });
        announce(companyId, row);
    }
    return { id: row.id, archived };
}

/** Show or hide a view on the caller's own Home (people only; any role that can open it). */
export async function setViewPinned(companyId: string, caller: ViewCaller, viewId: string, pinned: boolean): Promise<{ id: string; pinned: boolean }> {
    if (caller.kind !== "member") throw new ViewRefusedError("Only people pin views to their Home", 403);
    const { row } = await loadVisibleView(companyId, caller, viewId);
    if (pinned) {
        const [{ next }] = await db.select({ next: sql<number>`COALESCE(MAX(${viewPins.position}) + 1, 0)`.mapWith(Number) }).from(viewPins)
            .where(and(eq(viewPins.companyId, companyId), eq(viewPins.userId, caller.userId)));
        await db.insert(viewPins).values({ companyId, userId: caller.userId, viewId: row.id, position: next }).onConflictDoNothing();
    } else {
        await db.delete(viewPins).where(and(eq(viewPins.companyId, companyId), eq(viewPins.userId, caller.userId), eq(viewPins.viewId, row.id)));
    }
    return { id: row.id, pinned };
}

/**
 * Who sees a view, set by its owner: private, shared (with `shareUserIds`,
 * each a member who can see the scope) or everyone in scope. Leaving
 * 'shared' drops the share list.
 */
export async function setViewVisibility(
    companyId: string, caller: ViewCaller, viewId: string, input: { visibility: unknown; shareUserIds?: unknown },
): Promise<ViewDetail> {
    if (caller.kind !== "member") throw new ViewRefusedError("Only the view's owner can change who sees it", 403);
    const { row } = await loadVisibleView(companyId, caller, viewId, { includeArchived: true });
    if (row.ownerUserId !== caller.userId) throw new ViewRefusedError("Only the view's owner can change who sees it", 403);
    const visibility = parseVisibility(input.visibility, VIEW_VISIBILITIES);
    if (!visibility) throw new ViewInputError(`visibility must be one of: ${VIEW_VISIBILITIES.join(", ")}`);
    let shareIds: string[] = [];
    if (visibility === "shared") {
        if (!Array.isArray(input.shareUserIds)) throw new ViewInputError("shareUserIds (the people to share with) is required for a shared view");
        shareIds = [...new Set(input.shareUserIds.filter((id): id is string => typeof id === "string"))].filter((id) => id !== row.ownerUserId);
        if (shareIds.length === 0) throw new ViewInputError("Pick at least one person to share with");
        if (shareIds.length > VIEW_MAX_SHARES) throw new ViewInputError(`A view can be shared with at most ${VIEW_MAX_SHARES} people`);
        for (const id of shareIds) {
            if (!(await personInScope(companyId, id, row))) throw new ViewInputError("Someone on that list is not a member who can see this view's scope");
        }
    }
    const previousShares = (await sharesOf([row.id])).get(row.id) ?? [];
    await db.transaction(async (tx) => {
        await tx.update(views).set({ visibility }).where(and(eq(views.id, row.id), eq(views.companyId, companyId)));
        await tx.delete(viewShares).where(eq(viewShares.viewId, row.id));
        if (shareIds.length) await tx.insert(viewShares).values(shareIds.map((userId) => ({ companyId, viewId: row.id, userId })));
    });
    const sameShares = [...previousShares].sort().join() === [...shareIds].sort().join();
    if (row.visibility !== visibility || !sameShares) {
        // Who it is shared with stays out of the log: a count only.
        await recordAudit({
            companyId, actor: actorOf(caller), action: "view.visibility_changed", target: { type: "view", id: row.id },
            before: { visibility: row.visibility, sharedCount: previousShares.length }, after: { visibility, sharedCount: shareIds.length }, meta: { label: row.title },
        });
    }
    announce(companyId, row);
    return getView(companyId, caller, row.id, { includeArchived: true });
}

/**
 * Hand a view to another person (offboarding): owners/admins, without reading
 * it, or its current owner. The new owner must be a member who can see the
 * scope; they leave the share list if they were on it.
 */
export async function transferViewOwner(companyId: string, caller: ViewCaller, viewId: string, toUserId: unknown): Promise<{ id: string; owner: Named }> {
    if (caller.kind !== "member") throw new ViewRefusedError("Only owners, admins and the view's owner can transfer it", 403);
    const { row, access } = await loadVisibleView(companyId, caller, viewId, { includeArchived: true, need: "metadata" });
    if (!isAdminRole(caller.role) && row.ownerUserId !== caller.userId) throw new ViewRefusedError("Only owners, admins and the view's owner can transfer it", 403);
    // An admin who only sees its name must not make it theirs: that would open it to them.
    if (toUserId === caller.userId && access !== "full") throw new ViewRefusedError("You cannot give yourself a view you cannot open; hand it to someone else", 403);
    const person = await personInScope(companyId, toUserId, row);
    if (!person) throw new ViewInputError("The new owner must be a member who can see this view's scope");
    if (person.userId === row.ownerUserId) throw new ViewInputError("That person already owns this view; pick someone else");
    await db.transaction(async (tx) => {
        await tx.update(views).set({ ownerUserId: person.userId }).where(and(eq(views.id, row.id), eq(views.companyId, companyId)));
        await tx.delete(viewShares).where(and(eq(viewShares.viewId, row.id), eq(viewShares.userId, person.userId)));
    });
    await recordAudit({
        companyId, actor: actorOf(caller), action: "view.owner_transferred", target: { type: "view", id: row.id },
        before: { ownerUserId: row.ownerUserId }, after: { ownerUserId: person.userId }, meta: { label: row.title, toName: person.name },
    });
    await notifyViewTransferred(companyId, row, { previousOwnerId: row.ownerUserId, to: person, byUserId: caller.userId });
    announce(companyId, row);
    return { id: row.id, owner: { id: person.userId, name: person.name } };
}

/** Tell the previous and the new owner (not whoever did it, they know). Never breaks the transfer. */
async function notifyViewTransferred(companyId: string, row: ViewRow, input: { previousOwnerId: string | null; to: { userId: string; name: string }; byUserId: string }) {
    try {
        const { notify } = await import("@/lib/notifications");
        const by = (await companyPerson(companyId, input.byUserId))?.name ?? "An admin";
        const common = {
            kind: "view_transferred" as const, link: `/views/${row.id}`, sourceType: "view", sourceId: row.id,
            // A private view's title never reaches the company webhook.
            privateOutboundTitle: row.visibility === "scope" ? null : "A view changed owner",
        };
        if (input.previousOwnerId && input.previousOwnerId !== input.byUserId) {
            await notify(companyId, [input.previousOwnerId], { ...common, title: `Your view "${row.title}" was transferred to ${input.to.name} by ${by}`, dedupeKey: `view_transferred:${row.id}:from:${input.previousOwnerId}` });
        }
        if (input.to.userId !== input.byUserId) {
            await notify(companyId, [input.to.userId], { ...common, title: `${by} gave you the view "${row.title}"`, dedupeKey: `view_transferred:${row.id}:to:${input.to.userId}` });
        }
    } catch (error) {
        console.warn("[views] transfer notification failed:", error instanceof Error ? error.message : error);
    }
}

/** Delete a view for good (versions, values, shares and pins go with it): owners/admins, without reading it, or its owner. */
export async function deleteView(companyId: string, caller: ViewCaller, viewId: string): Promise<{ id: string; deleted: true }> {
    if (caller.kind !== "member") throw new ViewRefusedError("Only owners, admins and the view's owner can delete it", 403);
    const { row } = await loadVisibleView(companyId, caller, viewId, { includeArchived: true, need: "metadata" });
    if (!isAdminRole(caller.role) && row.ownerUserId !== caller.userId) throw new ViewRefusedError("Only owners, admins and the view's owner can delete it", 403);
    // Tell the people who had it open before the row (and its audience) is gone.
    await deliverViewUpdated(companyId, row.id).catch(() => {});
    await db.delete(views).where(and(eq(views.id, row.id), eq(views.companyId, companyId)));
    await recordAudit({
        companyId, actor: actorOf(caller), action: "view.deleted", target: { type: "view", id: row.id },
        before: { title: row.title, scopeType: row.scopeType, scopeId: row.scopeId, visibility: row.visibility, ownerUserId: row.ownerUserId }, meta: { label: row.title },
    });
    return { id: row.id, deleted: true };
}

/**
 * Bring back an earlier layout and title as a NEW version (history is never
 * rewritten). Values of panels the old layout does not have are dropped.
 */
export async function revertView(companyId: string, caller: ViewCaller, viewId: string, version: unknown): Promise<ViewDetail> {
    const { row } = await loadVisibleView(companyId, caller, viewId);
    assertMayWrite(caller, row);
    const wanted = typeof version === "number" ? version : typeof version === "string" ? Number(version) : NaN;
    if (!Number.isInteger(wanted) || wanted < 1) throw new ViewInputError("version must be a version number");
    const [old] = await db.select().from(viewVersions)
        .where(and(eq(viewVersions.companyId, companyId), eq(viewVersions.viewId, row.id), eq(viewVersions.version, wanted))).limit(1);
    if (!old) throw new ViewInputError("Version not found");
    const spec = storedViewSpec(old.specJson);
    return updateView(companyId, caller, row.id, { title: old.title, panels: spec.panels }, { revertedFrom: wanted });
}

/** The agent that should refresh a view: its creator when that was an agent. */
export function owningAgentId(view: { createdBy: { type: string; id: string | null } }): string | null {
    return maintainerAgentId({ createdByType: view.createdBy.type, createdById: view.createdBy.id });
}

export type PinnedViewCard = {
    id: string;
    title: string;
    scopeType: ViewScopeType;
    scopeLabel: string | null;
    visibility: ViewVisibility;
    panelCount: number;
    dataUpdatedAt: string | null;
    refreshEveryMinutes: number | null;
    createdAt: string;
    /** Up to three headline numbers (metric and progress panels), for Home. */
    highlights: { id: string; type: "metric" | "progress"; title: string; data: ViewPanelData }[];
};

/** This person's Home pins (views they can fully open), in pin order, with their headline numbers. */
export async function loadPinnedViewCards(companyId: string, caller: ViewCaller, limit = 6): Promise<PinnedViewCard[]> {
    const pinned = (await listViews(companyId, caller, { pinnedOnly: true, limit: 50 })).slice(0, limit);
    if (pinned.length === 0) return [];
    const ids = pinned.map((v) => v.id);
    const layouts = await db.select({ id: views.id, specJson: views.specJson }).from(views).where(and(eq(views.companyId, companyId), inArray(views.id, ids)));
    const specOf = new Map(layouts.map((row) => [row.id, storedViewSpec(row.specJson)]));
    // Only the headline panels' values: a table or markdown panel can be hundreds of KB.
    const wanted = [...specOf].map(([viewId, spec]) => ({
        viewId, panelIds: spec.panels.filter((p) => p.type === "metric" || p.type === "progress").map((p) => p.id),
    })).filter((w) => w.panelIds.length > 0);
    const dataRows = wanted.length === 0 ? [] : await db.select({ viewId: viewPanelData.viewId, panelId: viewPanelData.panelId, dataJson: viewPanelData.dataJson })
        .from(viewPanelData).where(and(
            eq(viewPanelData.companyId, companyId),
            or(...wanted.map((w) => and(eq(viewPanelData.viewId, w.viewId), inArray(viewPanelData.panelId, w.panelIds)))),
        ));
    const dataOf = new Map(dataRows.map((row) => [`${row.viewId}:${row.panelId}`, row.dataJson]));
    return pinned.map((view) => {
        const highlights: PinnedViewCard["highlights"] = [];
        for (const panel of specOf.get(view.id)?.panels ?? []) {
            if (highlights.length >= 3) break;
            if (panel.type !== "metric" && panel.type !== "progress") continue;
            const data = storedPanelData(panel.type, dataOf.get(`${view.id}:${panel.id}`));
            if (data) highlights.push({ id: panel.id, type: panel.type, title: panel.title, data });
        }
        return {
            id: view.id, title: view.title, scopeType: view.scopeType, scopeLabel: view.scopeLabel, visibility: view.visibility,
            panelCount: view.panelCount, dataUpdatedAt: view.dataUpdatedAt, refreshEveryMinutes: view.refreshEveryMinutes, createdAt: view.createdAt, highlights,
        };
    });
}

/** Route error mapping shared by /api/views and /api/mcp/views. */
export function viewErrorResponse(error: unknown): NextResponse {
    if (error instanceof ViewNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof ViewInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof ViewRefusedError) return NextResponse.json({ error: error.message }, { status: error.status });
    const denied = mcpAccessErrorResponse(error);
    if (denied) return denied;
    console.error("View request failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}
