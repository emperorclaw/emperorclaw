import { db } from "@/db";
import { agents, auditLog, users } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";
import {
    changedFields, redactAuditPayload, scopeAuditFields,
    type AuditActor, type AuditFields, type AuditTargetType,
} from "@/lib/audit-format";
import { splitProjectTitle } from "@/lib/project-title";

export type { AuditActor, AuditTargetType } from "@/lib/audit-format";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RecordAuditInput = {
    companyId: string;
    actor: AuditActor;
    action: string;
    target: { type: AuditTargetType; id: string };
    before?: AuditFields | null;
    after?: AuditFields | null;
    meta?: AuditFields | null;
};

export const SYSTEM_ACTOR: AuditActor = { type: "system", id: null };

/** A signed-in person acting through the app. */
export function humanActor(userId: string | null | undefined): AuditActor {
    return userId ? { type: "human", id: userId } : SYSTEM_ACTOR;
}

/**
 * The caller behind an MCP token: the agent it is bound to, else "system"
 * with the token id (a company-wide token acting for an operator script).
 */
export function mcpActor(agentId: string | null | undefined, tokenId?: string | null): AuditActor {
    return agentId ? { type: "agent", id: agentId, tokenId: tokenId ?? null } : { type: "system", id: null, tokenId: tokenId ?? null };
}

/**
 * The actor of an MCP REST request: the token's bound agent; for a company-wide
 * token, the agent it names (?agentId= / body agentId, by id or name); else
 * "system" with the token id. Never creates an agent.
 */
export async function mcpRequestActor(companyId: string, token: { id: string; agentId?: string | null }, requestedAgentId?: unknown): Promise<AuditActor> {
    if (token.agentId) return mcpActor(token.agentId, token.id);
    const ref = typeof requestedAgentId === "string" ? requestedAgentId.trim() : "";
    if (!ref) return mcpActor(null, token.id);
    try {
        const [agent] = await db.select({ id: agents.id }).from(agents).where(and(
            eq(agents.companyId, companyId), isNull(agents.deletedAt), UUID_RE.test(ref) ? eq(agents.id, ref) : eq(agents.name, ref),
        )).limit(1);
        return mcpActor(agent?.id ?? null, token.id);
    } catch {
        return mcpActor(null, token.id);
    }
}

function toRow(input: RecordAuditInput) {
    const meta: AuditFields = { ...(input.meta ?? {}) };
    if (input.actor.tokenId) meta.tokenId = input.actor.tokenId;
    const payload = redactAuditPayload(input.target.type, { before: input.before ?? undefined, after: input.after ?? undefined, meta });
    return {
        companyId: input.companyId,
        actorType: input.actor.type,
        actorId: input.actor.id && UUID_RE.test(input.actor.id) ? input.actor.id : null,
        action: input.action,
        targetType: input.target.type,
        targetId: input.target.id,
        payloadJson: payload,
    };
}

/**
 * Write activity rows (the Activity page, admin only). Never throws: an audit
 * failure (mapping, redaction or insert) is logged and the mutation that
 * called it carries on. Payloads go through the redaction allowlist
 * (lib/audit-format.ts), so callers may pass whole snapshots; only titles,
 * ids, states, names and numbers are kept.
 */
export async function recordAudits(inputs: readonly RecordAuditInput[]): Promise<void> {
    try {
        const rows = inputs.filter((i) => i?.companyId && typeof i.target?.id === "string" && UUID_RE.test(i.target.id)).map(toRow);
        if (rows.length === 0) return;
        await db.insert(auditLog).values(rows);
        // Open Activity pages refetch (realtime topic "activity").
        for (const companyId of new Set(rows.map((r) => r.companyId))) {
            Promise.resolve(broadcastMcpEvent(companyId, { type: "audit_recorded" })).catch(() => {});
        }
    } catch (error) {
        console.error("Failed to record audit entry:", error);
    }
}

export async function recordAudit(input: RecordAuditInput): Promise<void> {
    try {
        await recordAudits([input]);
    } catch (error) {
        console.error("Failed to record audit entry:", error);
    }
}

type AgentSnapshot = {
    id: string;
    name?: string | null;
    role?: string | null;
    provider?: string | null;
    deploymentMode?: string | null;
    llmProvider?: string | null;
    llmModel?: string | null;
    concurrencyLimit?: number | null;
    monthlyBudgetCents?: number | null;
    budgetStatus?: string | null;
    scopeJson?: unknown;
};

const AGENT_SETTINGS = ["name", "role", "provider", "deploymentMode", "llmProvider", "llmModel", "concurrencyLimit"] as const;

function pick(row: AgentSnapshot, keys: readonly (keyof AgentSnapshot)[]): AuditFields {
    const out: AuditFields = {};
    for (const key of keys) if (row[key] !== undefined) out[key] = row[key];
    return out;
}

/**
 * One agent edit as activity: a pause or resume (budget state), a budget
 * change, a scope change and a settings change (name, role, model…) are each
 * their own entry; avatar/doctrine/memory edits record nothing.
 */
export async function recordAgentChange(companyId: string, actor: AuditActor, before: AgentSnapshot, after: AgentSnapshot): Promise<void> {
    try {
        await recordAudits(agentChangeEntries(companyId, actor, before, after));
    } catch (error) {
        console.error("Failed to record agent change:", error);
    }
}

function agentChangeEntries(companyId: string, actor: AuditActor, before: AgentSnapshot, after: AgentSnapshot): RecordAuditInput[] {
    const target = { type: "agent" as const, id: after.id };
    const meta = { label: after.name ?? before.name ?? null };
    const entries: RecordAuditInput[] = [];
    const wasPaused = before.budgetStatus === "paused";
    const isPaused = after.budgetStatus === "paused";
    if (after.budgetStatus !== undefined && wasPaused !== isPaused) {
        entries.push({ companyId, actor, action: isPaused ? "agent.paused" : "agent.resumed", target, before: { budgetStatus: before.budgetStatus }, after: { budgetStatus: after.budgetStatus }, meta });
    }
    if (after.monthlyBudgetCents !== undefined && after.monthlyBudgetCents !== before.monthlyBudgetCents) {
        entries.push({ companyId, actor, action: "agent.budget_changed", target, before: { monthlyBudgetCents: before.monthlyBudgetCents ?? 0 }, after: { monthlyBudgetCents: after.monthlyBudgetCents }, meta });
    }
    if (after.scopeJson !== undefined) {
        const diff = changedFields(scopeAuditFields(before.scopeJson), scopeAuditFields(after.scopeJson));
        if (Object.keys(diff.after).length > 0) entries.push({ companyId, actor, action: "agent.scope_changed", target, ...diff, meta });
    }
    const settings = changedFields(pick(before, AGENT_SETTINGS), pick(after, AGENT_SETTINGS));
    if (Object.keys(settings.after).length > 0) entries.push({ companyId, actor, action: "agent.updated", target, ...settings, meta });
    return entries;
}

type TaskSnapshot = {
    id: string;
    projectId?: string | null;
    taskType?: string | null;
    state?: string | null;
    assignedAgentId?: string | null;
    assignedMemberId?: string | null;
    inputJson?: unknown;
};

/** A task's title as the board shows it (input title, else its type). */
export function auditTaskTitle(task: TaskSnapshot): string | null {
    const input = task.inputJson && typeof task.inputJson === "object" ? task.inputJson as Record<string, unknown> : {};
    return typeof input.title === "string" && input.title.trim() ? input.title.trim() : task.taskType ?? null;
}

function taskAssignee(task: TaskSnapshot): AuditFields {
    if (task.assignedMemberId) return { assigneeType: "member", assigneeId: task.assignedMemberId };
    if (task.assignedAgentId) return { assigneeType: "agent", assigneeId: task.assignedAgentId };
    return { assigneeType: null, assigneeId: null };
}

/**
 * The activity entries for one task edit: a state change and/or a new
 * assignee. Never throws (a malformed snapshot yields no entries), since
 * callers build these inline in the mutation.
 */
export function taskChangeEntries(companyId: string, actor: AuditActor, before: TaskSnapshot, after: TaskSnapshot, meta: AuditFields = {}): RecordAuditInput[] {
    try {
        return buildTaskChangeEntries(companyId, actor, before, after, meta);
    } catch (error) {
        console.error("Failed to build task audit entries:", error);
        return [];
    }
}

function buildTaskChangeEntries(companyId: string, actor: AuditActor, before: TaskSnapshot, after: TaskSnapshot, meta: AuditFields): RecordAuditInput[] {
    const target = { type: "task" as const, id: after.id };
    const fullMeta = { label: auditTaskTitle(after), projectId: after.projectId ?? null, ...meta };
    const entries: RecordAuditInput[] = [];
    if (after.state && before.state !== after.state) {
        entries.push({ companyId, actor, action: "task.state_changed", target, before: { state: before.state }, after: { state: after.state }, meta: fullMeta });
    }
    const was = taskAssignee(before);
    const now = taskAssignee(after);
    if (was.assigneeId !== now.assigneeId || was.assigneeType !== now.assigneeType) {
        entries.push({ companyId, actor, action: "task.assigned", target, before: was, after: now, meta: fullMeta });
    }
    return entries;
}

export async function recordTaskChange(companyId: string, actor: AuditActor, before: TaskSnapshot, after: TaskSnapshot, meta: AuditFields = {}): Promise<void> {
    try {
        await recordAudits(taskChangeEntries(companyId, actor, before, after, meta));
    } catch (error) {
        console.error("Failed to record task change:", error);
    }
}

/**
 * A change to a person's membership (role, access, removal). The person's
 * name and email are looked up for the entry's label, since a removed member
 * can no longer be resolved later.
 */
export async function recordMemberAudit(companyId: string, actor: AuditActor, action: string, userId: string, before?: AuditFields | null, after?: AuditFields | null): Promise<void> {
    let person: { displayName: string | null; email: string } | undefined;
    try {
        [person] = await db.select({ displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    } catch {
        person = undefined;
    }
    await recordAudit({
        companyId, actor, action, target: { type: "member", id: userId }, before, after,
        meta: { label: person?.displayName || person?.email || null, email: person?.email ?? null },
    });
}

type ProjectSnapshot = {
    id: string;
    goal: string;
    status?: string | null;
    customerId?: string | null;
    leadAgentId?: string | null;
    requireApprovalForDone?: boolean | null;
    maxActiveAgents?: number | null;
};

function projectFields(project: ProjectSnapshot): AuditFields {
    return {
        name: splitProjectTitle(project.goal).name, status: project.status, customerId: project.customerId ?? null,
        leadAgentId: project.leadAgentId ?? null, requireApprovalForDone: project.requireApprovalForDone, maxActiveAgents: project.maxActiveAgents,
    };
}

/** Project created / edited (only the fields that changed) / archived. */
export async function recordProjectAudit(companyId: string, actor: AuditActor, action: "project.created" | "project.updated" | "project.archived", project: ProjectSnapshot, before?: ProjectSnapshot | null): Promise<void> {
    try {
        const target = { type: "project" as const, id: project.id };
        const meta = { label: splitProjectTitle(project.goal).name };
        if (action === "project.created") return await recordAudit({ companyId, actor, action, target, after: projectFields(project), meta });
        if (action === "project.archived") return await recordAudit({ companyId, actor, action, target, before: projectFields(project), after: { archived: true }, meta });
        const diff = changedFields(projectFields(before ?? project), projectFields(project));
        if (Object.keys(diff.after).length > 0) await recordAudit({ companyId, actor, action, target, ...diff, meta });
    } catch (error) {
        console.error("Failed to record project change:", error);
    }
}
