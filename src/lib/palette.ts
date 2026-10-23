/**
 * Records the command palette can jump to, filtered exactly like the inbox
 * (src/lib/attention-rules.ts applyAttentionScope): a restricted member never
 * sees an agent or a customer outside their scope, nor a project or task that
 * belongs to one.
 */

import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, customers, projects, tasks } from "@/db/schema";
import type { AttentionScope } from "@/lib/attention-rules";
import { VISIBLE_OPEN_TASK_STATES } from "@/lib/task-state";

export interface PaletteData {
    agents: { id: string; name: string; role: string | null }[];
    projects: { id: string; name: string; customerName: string | null }[];
    customers: { id: string; name: string }[];
    tasks: { id: string; title: string; projectId: string; projectName: string | null; state: string }[];
}

export const PALETTE_TASK_LIMIT = 20;
const LIST_LIMIT = 200;

/** Escape LIKE wildcards so a typed % or _ matches itself. */
function likePattern(q: string): string {
    return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function loadPaletteData(companyId: string, scope: AttentionScope | null, query = ""): Promise<PaletteData> {
    // undefined = unrestricted; an empty list grants nothing (fail closed).
    const agentScope = scope?.agentIds ? [...scope.agentIds] : null;
    const customerScope = scope?.customerIds ? [...scope.customerIds] : null;
    const q = query.trim().slice(0, 100);
    const none = <T,>(): Promise<T[]> => Promise.resolve([]);

    const [agentRows, customerRows, projectRows] = await Promise.all([
        agentScope?.length === 0 ? none<{ id: string; name: string; role: string | null }>() : db.select({ id: agents.id, name: agents.name, role: agents.role }).from(agents)
            .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt), agentScope ? inArray(agents.id, agentScope) : undefined))
            .orderBy(agents.name).limit(LIST_LIMIT),
        customerScope?.length === 0 ? none<{ id: string; name: string }>() : db.select({ id: customers.id, name: customers.name }).from(customers)
            .where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt), customerScope ? inArray(customers.id, customerScope) : undefined))
            .orderBy(customers.name).limit(LIST_LIMIT),
        customerScope?.length === 0 ? none<{ id: string; name: string; customerId: string | null }>() : db.select({ id: projects.id, name: projects.goal, customerId: projects.customerId }).from(projects)
            .where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt), customerScope ? inArray(projects.customerId, customerScope) : undefined))
            .orderBy(desc(projects.updatedAt)).limit(LIST_LIMIT),
    ]);
    const customerName = new Map(customerRows.map((c) => [c.id, c.name]));
    const projectName = new Map(projectRows.map((p) => [p.id, p.name]));
    const visibleProjectIds = projectRows.map((p) => p.id);

    // Open tasks in visible projects, most recently touched first. A task held
    // by an agent outside the member's scope stays hidden.
    const taskRows = visibleProjectIds.length === 0 ? [] : await db.select({ id: tasks.id, inputJson: tasks.inputJson, taskType: tasks.taskType, projectId: tasks.projectId, state: tasks.state, assignedAgentId: tasks.assignedAgentId })
        .from(tasks)
        .where(and(
            eq(tasks.companyId, companyId),
            isNull(tasks.deletedAt),
            inArray(tasks.state, [...VISIBLE_OPEN_TASK_STATES]),
            inArray(tasks.projectId, visibleProjectIds),
            agentScope ? (agentScope.length ? or(isNull(tasks.assignedAgentId), inArray(tasks.assignedAgentId, agentScope)) : isNull(tasks.assignedAgentId)) : undefined,
            q ? or(ilike(sql`${tasks.inputJson}->>'title'`, likePattern(q)), ilike(tasks.taskType, likePattern(q))) : undefined,
        ))
        .orderBy(desc(tasks.updatedAt)).limit(PALETTE_TASK_LIMIT);

    return {
        agents: agentRows,
        customers: customerRows,
        projects: projectRows.map((p) => ({ id: p.id, name: p.name, customerName: p.customerId ? customerName.get(p.customerId) ?? null : null })),
        tasks: taskRows.map((t) => {
            const input = t.inputJson && typeof t.inputJson === "object" ? t.inputJson as Record<string, unknown> : {};
            const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : t.taskType;
            return { id: t.id, title, projectId: t.projectId, projectName: projectName.get(t.projectId) ?? null, state: t.state };
        }),
    };
}
