import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { mcpMayUseResource, type McpAgentAccess } from "@/lib/mcp-access";
import { db } from "@/db";
import {
  agents,
  messageThreads,
  projectAgentProfiles,
  projectMemory,
  projects,
  scopedResources,
  taskEvents,
  tasks,
  threadMessages,
  customers,
} from "@/db/schema";
import { getPendingApprovalSummaryForTaskIds } from "@/lib/project-workflow";
import { toPublicResource } from "@/lib/resources";
import { classifyTaskRef } from "@/lib/task-id";

/**
 * Resolve what a caller sent as a task id into the real task id.
 *
 * A UUID (or its dash-less form) is returned as-is: existence is the detail
 * query's business, and answering 404 from here would change what a valid but
 * missing id looks like. A short code is looked up as a prefix inside the
 * company, because that is how it is derived — `id.slice(0, 8).toUpperCase()`
 * in the detail payload, not a stored column.
 *
 * The prefix comparison casts the id to text, so it cannot use the primary key
 * index. That is deliberate: this path only runs for the legacy short-code
 * shape (a few log lines a day), never for a normal UUID lookup, and keeping it
 * a plain LIKE avoids a second column that could drift from the id.
 */
export async function resolveTaskIdForCompany(
  companyId: string,
  raw: string | null | undefined,
): Promise<{ ok: true; id: string } | { ok: false; status: 400 | 404 | 409; error: string }> {
  const ref = classifyTaskRef(raw);
  if (ref.kind === "invalid") return { ok: false, status: 400, error: ref.error };
  if (ref.kind === "id") return { ok: true, id: ref.id };

  const rows = await db.select({ id: tasks.id }).from(tasks)
    .where(and(
      eq(tasks.companyId, companyId),
      isNull(tasks.deletedAt),
      // Dashes stripped: a short code is the head of the id, and a caller who
      // truncated a dash-less id must still match the same task.
      sql`replace(${tasks.id}::text, '-', '') like ${`${ref.prefix}%`}`,
    ))
    .limit(2);

  if (rows.length === 0) {
    return { ok: false, status: 404, error: `Task not found for id "${ref.prefix}" (no task in this company starts with that code).` };
  }
  if (rows.length > 1) {
    return {
      ok: false,
      status: 409,
      error: `Task id "${ref.prefix}" is ambiguous: ${rows.length} tasks start with that code. Send the full UUID.`,
    };
  }
  return { ok: true, id: rows[0].id };
}

export async function getTaskDetailForCompany(companyId: string, taskId: string) {
  const rows = await db.select({
    task: tasks,
    project: projects,
    customer: customers,
    assignedAgent: agents,
  }).from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .leftJoin(customers, eq(projects.customerId, customers.id))
    .leftJoin(agents, eq(tasks.assignedAgentId, agents.id))
    .where(and(
      eq(tasks.companyId, companyId),
      eq(tasks.id, taskId),
      isNull(tasks.deletedAt),
      isNull(projects.deletedAt),
    ))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const approvalSummary = await getPendingApprovalSummaryForTaskIds(companyId, [taskId]);
  const summary = approvalSummary.get(taskId);
  const inputJson = row.task.inputJson && typeof row.task.inputJson === "object"
    ? row.task.inputJson as Record<string, unknown>
    : {};

  return {
    ...row.task,
    shortCode: String(row.task.id).slice(0, 8).toUpperCase(),
    title: typeof inputJson.title === "string" ? inputJson.title : null,
    description: typeof inputJson.description === "string" ? inputJson.description : null,
    acceptanceCriteria: Array.isArray(inputJson.acceptanceCriteria)
      ? inputJson.acceptanceCriteria
      : typeof inputJson.acceptanceCriteria === "string"
        ? [inputJson.acceptanceCriteria]
        : [],
    definitionOfDone: typeof inputJson.definitionOfDone === "string" ? inputJson.definitionOfDone : null,
    deliverables: Array.isArray(inputJson.deliverables)
      ? inputJson.deliverables
      : typeof inputJson.deliverables === "string"
        ? [inputJson.deliverables]
        : [],
    blockedReason: typeof inputJson.blockedReason === "string" ? inputJson.blockedReason : null,
    goal: typeof inputJson.goal === "string" ? inputJson.goal : null,
    ownerRole: typeof inputJson.ownerRole === "string" ? inputJson.ownerRole : null,
    project: row.project,
    customer: row.customer || null,
    assignedAgent: row.assignedAgent || null,
    approvalSummary: {
      total: summary?.total || 0,
      pending: summary?.pending || 0,
      latestPendingApprovalId: summary?.latestApprovalId || null,
    },
  };
}

/**
 * `access` is the calling agent's scope (lib/mcp-access.ts): every knowledge
 * resource in the pack goes through the same read rule as the knowledge index,
 * so a shared note of another project or another agent's private note never
 * rides along with an in-scope task.
 */
export async function getTaskContextForCompany(companyId: string, taskId: string, access?: McpAgentAccess) {
  const detail = await getTaskDetailForCompany(companyId, taskId);
  if (!detail) return null;

  const [
    notes,
    projectMemoryItems,
    projectResources,
    customerResources,
    sharedAndCompanyResources,
    agentResources,
    relatedThreads,
    relatedProfile
  ] = await Promise.all([
    db.select().from(taskEvents).where(and(
      eq(taskEvents.companyId, companyId),
      eq(taskEvents.taskId, taskId),
    )).orderBy(asc(taskEvents.createdAt)),
    db.select().from(projectMemory).where(and(
      eq(projectMemory.companyId, companyId),
      eq(projectMemory.projectId, detail.projectId),
    )).orderBy(desc(projectMemory.createdAt)).limit(20),
    db.select().from(scopedResources).where(and(
      eq(scopedResources.companyId, companyId),
      eq(scopedResources.scopeType, "project"),
      eq(scopedResources.scopeId, detail.projectId),
      isNull(scopedResources.deletedAt),
    )).orderBy(desc(scopedResources.updatedAt)).limit(20),
    detail.customer?.id
      ? db.select().from(scopedResources).where(and(
          eq(scopedResources.companyId, companyId),
          eq(scopedResources.scopeType, "customer"),
          eq(scopedResources.scopeId, detail.customer.id),
          isNull(scopedResources.deletedAt),
        )).orderBy(desc(scopedResources.updatedAt)).limit(20)
      : Promise.resolve([]),
    db.select().from(scopedResources).where(and(
      eq(scopedResources.companyId, companyId),
      or(
        eq(scopedResources.isShared, true),
        eq(scopedResources.scopeType, "company")
      ),
      isNull(scopedResources.deletedAt),
    )).orderBy(desc(scopedResources.updatedAt)).limit(20),
    detail.assignedAgentId
      ? db.select().from(scopedResources).where(and(
          eq(scopedResources.companyId, companyId),
          eq(scopedResources.scopeType, "agent"),
          eq(scopedResources.scopeId, detail.assignedAgentId),
          isNull(scopedResources.deletedAt),
        )).orderBy(desc(scopedResources.updatedAt)).limit(20)
      : Promise.resolve([]),
    db.select({
      thread: messageThreads,
      message: threadMessages,
    }).from(messageThreads)
      .leftJoin(threadMessages, eq(threadMessages.threadId, messageThreads.id))
      .where(and(
        eq(messageThreads.companyId, companyId),
        eq(messageThreads.taskId, taskId),
        isNull(messageThreads.archivedAt),
      ))
      .orderBy(desc(threadMessages.createdAt))
      .limit(20),
    detail.assignedAgentId
      ? db.select().from(projectAgentProfiles).where(and(
          eq(projectAgentProfiles.companyId, companyId),
          eq(projectAgentProfiles.projectId, detail.projectId),
          eq(projectAgentProfiles.agentId, detail.assignedAgentId),
          isNull(projectAgentProfiles.deletedAt),
        )).limit(1).then((rows) => rows[0] || null)
      : Promise.resolve(null),
  ]);

  const threadMap = new Map<string, {
    thread: typeof messageThreads.$inferSelect,
    recentMessages: typeof threadMessages.$inferSelect[],
  }>();

  for (const row of relatedThreads) {
    if (!threadMap.has(row.thread.id)) {
      threadMap.set(row.thread.id, {
        thread: row.thread,
        recentMessages: [],
      });
    }
    if (row.message) {
      threadMap.get(row.thread.id)!.recentMessages.push(row.message);
    }
  }

  const visible = <T extends { scopeType: string; scopeId: string | null; name: string }>(rows: T[]) =>
    access ? rows.filter((row) => mcpMayUseResource(access, row)) : rows;

  return {
    task: detail,
    notes,
    projectMemory: projectMemoryItems,
    resources: {
      // This pack is fetched by agent runtimes: never expose secret columns.
      project: visible(projectResources).map(toPublicResource),
      customer: visible(customerResources).map(toPublicResource),
      shared: visible(sharedAndCompanyResources.filter(r => r.isShared)).map(toPublicResource),
      company: visible(sharedAndCompanyResources.filter(r => r.scopeType === "company")).map(toPublicResource),
      agent: visible(agentResources).map(toPublicResource),
    },
    relatedThreads: Array.from(threadMap.values()),
    agentProfile: relatedProfile,
  };
}
