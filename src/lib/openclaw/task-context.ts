import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
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

export async function getTaskContextForCompany(companyId: string, taskId: string) {
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

  return {
    task: detail,
    notes,
    projectMemory: projectMemoryItems,
    resources: {
      project: projectResources,
      customer: customerResources,
      shared: sharedAndCompanyResources.filter(r => r.isShared),
      company: sharedAndCompanyResources.filter(r => r.scopeType === "company"),
      agent: agentResources,
    },
    relatedThreads: Array.from(threadMap.values()),
    agentProfile: relatedProfile,
  };
}
