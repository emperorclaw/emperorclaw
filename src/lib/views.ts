// Views (roadmap 0.15): dashboards an agent builds and keeps up to date.
//
// One service for both callers: agents (MCP tools and the /api/mcp/views REST
// twin) and people (/api/views and the /views pages). Who may see a view is the
// knowledge-note rule: company views are open, customer and project views
// follow the caller's scope (an agent's scopeJson, a restricted member's
// customers). A view outside the caller's scope reads exactly like one that
// does not exist (ViewNotFoundError), so ids are not an existence oracle.
//
// The layout (views.spec_json, versioned in view_versions) and the values
// (view_panel_data, one row per panel) are stored apart: update_panel writes
// one data row and never touches the layout or its version.

import { and, desc, eq, inArray, isNull, isNotNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { agents, customers, projects, users, viewPanelData, views, viewVersions } from "@/db/schema";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { NextResponse } from "next/server";
import { mcpAccessErrorResponse, mcpMayUseResource, mcpMayWriteResourceScope, type McpAgentAccess } from "@/lib/mcp-access";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getScopedCustomerIds, memberMaySeeResource, memberVisibleProjectIds, type MemberScope } from "@/lib/member-scope";
import {
    jsonBytes, parsePanelData, parseViewDescription, parseViewPanels, parseViewTitle, planViewVersion, storedPanelData, storedViewSpec,
    VIEW_SCOPE_TYPES, VIEW_TOTAL_DATA_MAX_BYTES,
    type ViewPanelData, type ViewPanelLayout, type ViewScopeType, type ViewSpec,
} from "@/lib/view-spec";

/** Versions kept per view; older ones are pruned when a new one is written. */
export const VIEW_VERSIONS_KEPT = 50;

/** Views (not archived) one company may hold; past it create_view answers 409. */
export const VIEW_MAX_ACTIVE_PER_COMPANY = 200;

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
 * view it did not build), 409 (company view cap), 429 (panel update rate).
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

/** A request the caller can fix (bad spec, bad scope, unknown panel). */
export class ViewInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ViewInputError";
    }
}

/**
 * Who is reading or writing. Agents carry their MCP access (an operator token
 * naming no agent is unrestricted); people carry their member scope (null for
 * admins and unrestricted members). The role check (viewer reads, member
 * writes) is the route's job.
 */
export type ViewCaller =
    | { kind: "agent"; access: McpAgentAccess; actor: AuditActor }
    | { kind: "member"; userId: string; scope: MemberScope | null };

function actorOf(caller: ViewCaller): AuditActor {
    return caller.kind === "agent" ? caller.actor : { type: "human", id: caller.userId };
}

/** The (type, id) pair stored in created_by / updated_by / author columns. */
function stamp(caller: ViewCaller): { type: "agent" | "human" | "system"; id: string | null } {
    const actor = actorOf(caller);
    const id = actor.id && UUID_RE.test(actor.id) ? actor.id : null;
    return { type: actor.type, id };
}

type ViewRow = typeof views.$inferSelect;

async function mayRead(companyId: string, caller: ViewCaller, view: { scopeType: string; scopeId: string | null }): Promise<boolean> {
    if (caller.kind === "agent") return mcpMayUseResource(caller.access, view);
    return memberMaySeeResource(companyId, caller.scope, view);
}

/** SQL twin of mayRead for lists (undefined = no filter). */
async function readCondition(companyId: string, caller: ViewCaller): Promise<SQL | undefined> {
    let customerIds: string[] | null;
    let projectIds: string[] | null;
    if (caller.kind === "agent") {
        if (!caller.access.agentId) return undefined;
        customerIds = caller.access.allowedCustomerIds ? [...caller.access.allowedCustomerIds] : null;
        projectIds = caller.access.allowedProjectIds ? [...caller.access.allowedProjectIds] : null;
    } else {
        if (!caller.scope) return undefined;
        customerIds = getScopedCustomerIds(caller.scope) ?? [];
        projectIds = [...((await memberVisibleProjectIds(companyId, caller.scope)) ?? new Set<string>())];
    }
    if (!customerIds && !projectIds) return undefined;
    const allowed = (type: ViewScopeType, ids: string[] | null) => ids === null
        ? eq(views.scopeType, type)
        : ids.length > 0 ? and(eq(views.scopeType, type), inArray(views.scopeId, ids)) : undefined;
    return or(eq(views.scopeType, "company"), allowed("customer", customerIds), allowed("project", projectIds));
}

/** The scope a caller wants to file a view under: must exist in this company and be inside their scope. */
async function checkWritableScope(companyId: string, caller: ViewCaller, scopeType: unknown, scopeId: unknown): Promise<{ scopeType: ViewScopeType; scopeId: string | null }> {
    const type = (scopeType ?? "company") as ViewScopeType;
    if (!(VIEW_SCOPE_TYPES as readonly string[]).includes(type)) throw new ViewInputError(`scope must be one of: ${VIEW_SCOPE_TYPES.join(", ")}`);
    if (type === "company") return { scopeType: "company", scopeId: null };
    if (typeof scopeId !== "string" || !UUID_RE.test(scopeId)) throw new ViewInputError(`scopeId (a ${type} id) is required for a ${type} view`);
    const exists = type === "customer"
        ? (await db.select({ id: customers.id }).from(customers).where(and(eq(customers.companyId, companyId), eq(customers.id, scopeId), isNull(customers.deletedAt))).limit(1)).length > 0
        : (await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, scopeId), isNull(projects.deletedAt))).limit(1)).length > 0;
    const allowed = caller.kind === "agent"
        ? mcpMayWriteResourceScope(caller.access, type, scopeId)
        : await memberMaySeeResource(companyId, caller.scope, { scopeType: type, scopeId });
    // Missing and out-of-scope read the same.
    if (!exists || !allowed) throw new ViewInputError(`That ${type} was not found or is outside your scope`);
    return { scopeType: type, scopeId };
}

/**
 * Who may change a view it can see. People: the route already requires member
 * or above, and seeing the view means it is in their scope (admins and owners
 * see every view of the company). Agents: only the views they built. An
 * operator token naming no agent is unrestricted, as everywhere in MCP.
 */
function assertMayWrite(caller: ViewCaller, row: { createdByType: string; createdById: string | null }): void {
    if (caller.kind !== "agent" || !caller.access.agentId) return;
    if (row.createdByType === "agent" && row.createdById === caller.access.agentId) return;
    throw new ViewRefusedError(VIEW_NOT_OWNER_MESSAGE, 403);
}

/** Load a view the caller may see, or throw ViewNotFoundError. Archived views only with `includeArchived`. */
async function loadVisibleView(companyId: string, caller: ViewCaller, viewId: string, options: { includeArchived?: boolean } = {}): Promise<ViewRow> {
    if (typeof viewId !== "string" || !UUID_RE.test(viewId)) throw new ViewNotFoundError();
    const [row] = await db.select().from(views).where(and(eq(views.companyId, companyId), eq(views.id, viewId))).limit(1);
    if (!row || (row.archivedAt && !options.includeArchived) || !(await mayRead(companyId, caller, row))) throw new ViewNotFoundError();
    return row;
}

function auditFields(row: { title: string; scopeType: string; scopeId: string | null; version: number }, spec: ViewSpec) {
    return { title: row.title, scopeType: row.scopeType, scopeId: row.scopeId, panelCount: spec.panels.length, version: row.version };
}

type AnnounceState = { lastAt: number; timer: ReturnType<typeof setTimeout> | null; payload: Record<string, unknown> };
const announceStates = new Map<string, AnnounceState>();

function sendAnnounce(companyId: string, payload: Record<string, unknown>) {
    Promise.resolve(broadcastMcpEvent(companyId, payload)).catch(() => {});
}

/**
 * Tell open pages (and nothing more: ids only, never values). Coalesced per
 * view: at most one broadcast per VIEW_ANNOUNCE_INTERVAL_MS, the last one
 * trailing, so an agent pushing many panels triggers one page refresh.
 */
function announce(companyId: string, row: { id: string; scopeType: string; scopeId: string | null }) {
    const payload: Record<string, unknown> = { type: "view_updated", viewId: row.id };
    if (row.scopeType === "project") payload.projectId = row.scopeId;
    if (row.scopeType === "customer") payload.customerId = row.scopeId;
    const key = `${companyId}:${row.id}`;
    const now = Date.now();
    const state = announceStates.get(key);
    if (!state || (!state.timer && now - state.lastAt >= VIEW_ANNOUNCE_INTERVAL_MS)) {
        if (announceStates.size > 1000) {
            for (const [k, s] of announceStates) if (!s.timer && now - s.lastAt >= VIEW_ANNOUNCE_INTERVAL_MS) announceStates.delete(k);
        }
        announceStates.set(key, { lastAt: now, timer: null, payload });
        sendAnnounce(companyId, payload);
        return;
    }
    state.payload = payload;
    if (state.timer) return;
    state.timer = setTimeout(() => {
        state.timer = null;
        state.lastAt = Date.now();
        sendAnnounce(companyId, state.payload);
    }, Math.max(VIEW_ANNOUNCE_INTERVAL_MS - (now - state.lastAt), 0));
    state.timer.unref?.();
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export type ViewSummary = {
    id: string;
    title: string;
    description: string | null;
    scopeType: ViewScopeType;
    scopeId: string | null;
    scopeLabel: string | null;
    panelCount: number;
    version: number;
    pinnedToHome: boolean;
    archived: boolean;
    createdBy: { type: string; id: string | null; name: string | null };
    updatedAt: string;
    /** When the newest panel value arrived (null when no panel has data yet). */
    dataUpdatedAt: string | null;
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

async function scopeLabels(companyId: string, rows: { scopeType: string; scopeId: string | null }[]): Promise<Map<string, string>> {
    const customerIds = [...new Set(rows.filter((r) => r.scopeType === "customer" && r.scopeId).map((r) => r.scopeId!))];
    const projectIds = [...new Set(rows.filter((r) => r.scopeType === "project" && r.scopeId).map((r) => r.scopeId!))];
    const [c, p] = await Promise.all([
        customerIds.length ? db.select({ id: customers.id, name: customers.name }).from(customers).where(and(eq(customers.companyId, companyId), inArray(customers.id, customerIds))) : Promise.resolve([]),
        projectIds.length ? db.select({ id: projects.id, goal: projects.goal }).from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds))) : Promise.resolve([]),
    ]);
    const { splitProjectTitle } = await import("@/lib/project-title");
    return new Map<string, string>([
        ...c.map((r) => [r.id, r.name] as [string, string]),
        ...p.map((r) => [r.id, splitProjectTitle(r.goal).name] as [string, string]),
    ]);
}

export async function listViews(companyId: string, caller: ViewCaller, options: {
    scopeType?: ViewScopeType;
    scopeId?: string;
    includeArchived?: boolean;
    pinnedOnly?: boolean;
    limit?: number;
} = {}): Promise<ViewSummary[]> {
    const condition = await readCondition(companyId, caller);
    const rows = await db.select().from(views).where(and(
        eq(views.companyId, companyId),
        options.includeArchived ? undefined : isNull(views.archivedAt),
        options.pinnedOnly ? eq(views.pinnedToHome, true) : undefined,
        options.scopeType ? eq(views.scopeType, options.scopeType) : undefined,
        options.scopeId && UUID_RE.test(options.scopeId) ? eq(views.scopeId, options.scopeId) : undefined,
        condition,
    )).orderBy(desc(views.pinnedToHome), desc(views.updatedAt)).limit(Math.min(Math.max(options.limit ?? 200, 1), 500));
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const [freshness, labels, names] = await Promise.all([
        db.select({ viewId: viewPanelData.viewId, at: sql<Date>`max(${viewPanelData.updatedAt})` })
            .from(viewPanelData).where(and(eq(viewPanelData.companyId, companyId), inArray(viewPanelData.viewId, ids)))
            .groupBy(viewPanelData.viewId),
        scopeLabels(companyId, rows),
        loadNames(rows.filter((r) => r.createdByType === "agent" && r.createdById).map((r) => r.createdById!),
            rows.filter((r) => r.createdByType === "human" && r.createdById).map((r) => r.createdById!)),
    ]);
    const freshBy = new Map(freshness.map((f) => [f.viewId, f.at ? new Date(f.at).toISOString() : null]));
    return rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        scopeType: row.scopeType as ViewScopeType,
        scopeId: row.scopeId,
        scopeLabel: row.scopeId ? labels.get(row.scopeId) ?? null : null,
        panelCount: storedViewSpec(row.specJson).panels.length,
        version: row.version,
        pinnedToHome: row.pinnedToHome,
        archived: Boolean(row.archivedAt),
        createdBy: { type: row.createdByType, id: row.createdById, name: nameOf(names, row.createdByType, row.createdById) },
        updatedAt: row.updatedAt.toISOString(),
        dataUpdatedAt: freshBy.get(row.id) ?? null,
    }));
}

export type ViewPanel = ViewPanelLayout & {
    data: ViewPanelData | null;
    updatedAt: string | null;
    updatedBy: { type: string; id: string | null; name: string | null } | null;
};

export type ViewDetail = Omit<ViewSummary, "panelCount" | "dataUpdatedAt"> & {
    panels: ViewPanel[];
    updatedBy: { type: string; id: string | null; name: string | null };
    createdAt: string;
};

export async function getView(companyId: string, caller: ViewCaller, viewId: string, options: { includeArchived?: boolean } = {}): Promise<ViewDetail> {
    const row = await loadVisibleView(companyId, caller, viewId, options);
    const spec = storedViewSpec(row.specJson);
    const dataRows = await db.select().from(viewPanelData)
        .where(and(eq(viewPanelData.companyId, companyId), eq(viewPanelData.viewId, row.id)));
    const byPanel = new Map(dataRows.map((d) => [d.panelId, d]));
    const people = [row.createdByType === "human" ? row.createdById : null, row.updatedByType === "human" ? row.updatedById : null,
        ...dataRows.filter((d) => d.updatedByType === "human").map((d) => d.updatedById)].filter((id): id is string => Boolean(id));
    const bots = [row.createdByType === "agent" ? row.createdById : null, row.updatedByType === "agent" ? row.updatedById : null,
        ...dataRows.filter((d) => d.updatedByType === "agent").map((d) => d.updatedById)].filter((id): id is string => Boolean(id));
    const [names, labels] = await Promise.all([loadNames(bots, people), scopeLabels(companyId, [row])]);
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        scopeType: row.scopeType as ViewScopeType,
        scopeId: row.scopeId,
        scopeLabel: row.scopeId ? labels.get(row.scopeId) ?? null : null,
        version: row.version,
        pinnedToHome: row.pinnedToHome,
        archived: Boolean(row.archivedAt),
        createdBy: { type: row.createdByType, id: row.createdById, name: nameOf(names, row.createdByType, row.createdById) },
        updatedBy: { type: row.updatedByType, id: row.updatedById, name: nameOf(names, row.updatedByType, row.updatedById) },
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        panels: spec.panels.map((panel) => {
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
    const row = await loadVisibleView(companyId, caller, viewId, { includeArchived: true });
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

export type CreateViewInput = {
    title: unknown;
    description?: unknown;
    scopeType?: unknown;
    scopeId?: unknown;
    panels?: unknown;
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
    const scope = await checkWritableScope(companyId, caller, input.scopeType, input.scopeId);
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
            specJson: panels.value.spec, version: 1,
            createdByType: by.type, createdById: by.id, updatedByType: by.type, updatedById: by.id, createdAt: now, updatedAt: now,
        }).returning();
        await writeVersion(tx, companyId, created.id, 1, created.title, panels.value.spec, by, now);
        await upsertPanelData(tx, companyId, created.id, panels.value.data, by, now);
        return created;
    });

    await recordAudit({ companyId, actor: actorOf(caller), action: "view.created", target: { type: "view", id: row.id }, after: auditFields(row, panels.value.spec), meta: { label: row.title } });
    announce(companyId, row);
    return getView(companyId, caller, row.id);
}

export type UpdateViewInput = {
    title?: unknown;
    description?: unknown;
    panels?: unknown;
};

/**
 * Change a view's title, description and/or layout. A title or layout change
 * writes a new version; panels sent with `data` also refresh those values.
 * Values of panels the new layout drops are deleted.
 */
export async function updateView(
    companyId: string, caller: ViewCaller, viewId: string, input: UpdateViewInput,
    options: { revertedFrom?: number } = {},
): Promise<ViewDetail> {
    const existing = await loadVisibleView(companyId, caller, viewId);
    assertMayWrite(caller, existing);
    const title = input.title === undefined ? null : parseViewTitle(input.title);
    if (title && !title.ok) throw new ViewInputError(title.error);
    const description = input.description === undefined ? null : parseViewDescription(input.description);
    if (description && !description.ok) throw new ViewInputError(description.error);
    const panels = input.panels === undefined ? null : parseViewPanels(input.panels);
    if (panels && !panels.ok) throw new ViewInputError(`Invalid view: ${panels.error}`);
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
        const newData = panels?.ok ? panels.value.data : {};
        const descriptionChanged = nextDescription !== current.description;
        if (!plan.changed && !descriptionChanged && Object.keys(newData).length === 0) return { row: current, plan, spec: currentSpec, changed: false };

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
            title: plan.title, description: nextDescription, specJson: plan.spec, version: plan.version,
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
    const row = await loadVisibleView(companyId, caller, viewId);
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

/** Archive (hide) a view, or restore an archived one. Archived views keep their versions and values. */
export async function setViewArchived(companyId: string, caller: ViewCaller, viewId: string, archived: boolean): Promise<{ id: string; archived: boolean }> {
    const row = await loadVisibleView(companyId, caller, viewId, { includeArchived: true });
    assertMayWrite(caller, row);
    if (Boolean(row.archivedAt) === archived) return { id: row.id, archived };
    const by = stamp(caller);
    const [updated] = await db.update(views).set({
        archivedAt: archived ? new Date() : null,
        // An archived view leaves Home too.
        pinnedToHome: archived ? false : row.pinnedToHome,
        updatedByType: by.type, updatedById: by.id, updatedAt: new Date(),
    }).where(and(eq(views.id, row.id), eq(views.companyId, companyId), archived ? isNull(views.archivedAt) : isNotNull(views.archivedAt))).returning();
    if (updated) {
        await recordAudit({
            companyId, actor: actorOf(caller), action: archived ? "view.archived" : "view.restored", target: { type: "view", id: row.id },
            before: { archived: !archived }, after: { archived }, meta: { label: row.title },
        });
        announce(companyId, row);
    }
    return { id: row.id, archived };
}

/** Show or hide a view on Home. */
export async function setViewPinned(companyId: string, caller: ViewCaller, viewId: string, pinned: boolean): Promise<{ id: string; pinnedToHome: boolean }> {
    const row = await loadVisibleView(companyId, caller, viewId);
    assertMayWrite(caller, row);
    if (row.pinnedToHome !== pinned) {
        await db.update(views).set({ pinnedToHome: pinned }).where(and(eq(views.id, row.id), eq(views.companyId, companyId)));
        await recordAudit({
            companyId, actor: actorOf(caller), action: "view.updated", target: { type: "view", id: row.id },
            before: { pinnedToHome: row.pinnedToHome }, after: { pinnedToHome: pinned }, meta: { label: row.title },
        });
        announce(companyId, row);
    }
    return { id: row.id, pinnedToHome: pinned };
}

/**
 * Bring back an earlier layout and title as a NEW version (history is never
 * rewritten). Values of panels the old layout does not have are dropped.
 */
export async function revertView(companyId: string, caller: ViewCaller, viewId: string, version: unknown): Promise<ViewDetail> {
    const row = await loadVisibleView(companyId, caller, viewId);
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
    return view.createdBy.type === "agent" ? view.createdBy.id : null;
}

export type PinnedViewCard = {
    id: string;
    title: string;
    scopeType: ViewScopeType;
    scopeLabel: string | null;
    panelCount: number;
    dataUpdatedAt: string | null;
    /** Up to three headline numbers (metric and progress panels), for Home. */
    highlights: { id: string; type: "metric" | "progress"; title: string; data: ViewPanelData }[];
};

/** The views pinned to Home that this person may see, with their headline numbers. */
export async function loadPinnedViewCards(companyId: string, caller: ViewCaller, limit = 6): Promise<PinnedViewCard[]> {
    const pinned = await listViews(companyId, caller, { pinnedOnly: true, limit });
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
            id: view.id, title: view.title, scopeType: view.scopeType, scopeLabel: view.scopeLabel,
            panelCount: view.panelCount, dataUpdatedAt: view.dataUpdatedAt, highlights,
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
