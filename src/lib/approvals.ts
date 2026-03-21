import { randomUUID } from "crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { approvalTaskLinks, approvals, projects, taskEvents, tasks } from "@/db/schema";
import { broadcastMcpEvent } from "./pubsub";
import { TASK_STATES } from "./task-state";

export async function createApprovalRequest(input: {
  companyId: string;
  projectId: string;
  taskIds: string[];
  requesterAgentId?: string | null;
  rationale?: string | null;
  confidence?: number;
  actionType?: string;
  metadataJson?: Record<string, unknown>;
}) {
  const existingPending = await db.select({
    approvalId: approvalTaskLinks.approvalId,
  }).from(approvalTaskLinks)
    .innerJoin(approvals, eq(approvals.id, approvalTaskLinks.approvalId))
    .where(and(
      eq(approvalTaskLinks.companyId, input.companyId),
      inArray(approvalTaskLinks.taskId, input.taskIds),
      eq(approvals.status, "pending"),
    ))
    .limit(1);

  if (existingPending.length > 0) {
    const [existing] = await db.select().from(approvals).where(
      eq(approvals.id, existingPending[0].approvalId),
    ).limit(1);
    return existing || null;
  }

  const [approval] = await db.insert(approvals).values({
    id: randomUUID(),
    companyId: input.companyId,
    projectId: input.projectId,
    requesterAgentId: input.requesterAgentId || null,
    actionType: input.actionType || "task_done",
    rationale: input.rationale || null,
    confidence: input.confidence || 0,
    metadataJson: input.metadataJson || {},
  }).returning();

  await db.insert(approvalTaskLinks).values(
    input.taskIds.map((taskId) => ({
      companyId: input.companyId,
      approvalId: approval.id,
      taskId,
    })),
  );

  await broadcastMcpEvent(input.companyId, {
    type: "approval_created",
    approval,
    taskIds: input.taskIds,
  });

  return approval;
}

export async function resolveApproval(input: {
  companyId: string;
  approvalId: string;
  resolverUserId?: string | null;
  status: "approved" | "rejected";
  resolutionNote?: string | null;
}) {
  const [approval] = await db.update(approvals).set({
    status: input.status,
    resolverUserId: input.resolverUserId || null,
    resolutionNote: input.resolutionNote || null,
    resolvedAt: new Date(),
  }).where(and(
    eq(approvals.companyId, input.companyId),
    eq(approvals.id, input.approvalId),
  )).returning();

  if (!approval) return null;

  const linkedTasks = await db.select({
    taskId: approvalTaskLinks.taskId,
  }).from(approvalTaskLinks).where(eq(approvalTaskLinks.approvalId, approval.id));

  const taskIds = linkedTasks.map((item) => item.taskId);
  const linkedTaskRows = taskIds.length > 0
    ? await db.select({
      task: tasks,
      project: projects,
    }).from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(
        eq(tasks.companyId, input.companyId),
        inArray(tasks.id, taskIds),
      ))
    : [];

  const nextState = input.status === "approved" ? TASK_STATES.done : TASK_STATES.review;

  for (const row of linkedTaskRows) {
    if (row.task.state === TASK_STATES.done && nextState === TASK_STATES.done) {
      continue;
    }

    const [updatedTask] = await db.update(tasks).set({
      state: nextState,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: new Date(),
    }).where(eq(tasks.id, row.task.id)).returning();

    await db.insert(taskEvents).values({
      companyId: input.companyId,
      taskId: row.task.id,
      eventType: `task_${nextState}`,
      actorType: "human",
      actorId: input.resolverUserId || null,
      payloadJson: {
        approvalId: approval.id,
        approvalStatus: input.status,
        note: input.resolutionNote || null,
      },
    });

    await broadcastMcpEvent(input.companyId, {
      type: "task_updated",
      task: updatedTask,
    });
  }

  await broadcastMcpEvent(input.companyId, {
    type: "approval_updated",
    approval,
    taskIds,
  });

  return approval;
}

export async function listApprovalsForCompany(companyId: string) {
  const rows = await db.select({
    approval: approvals,
    projectGoal: projects.goal,
  }).from(approvals)
    .innerJoin(projects, eq(projects.id, approvals.projectId))
    .where(eq(approvals.companyId, companyId))
    .orderBy(desc(approvals.requestedAt));

  const taskLinks = await db.select().from(approvalTaskLinks).where(eq(approvalTaskLinks.companyId, companyId));
  const taskIdsByApproval = taskLinks.reduce<Record<string, string[]>>((acc, link) => {
    if (!acc[link.approvalId]) acc[link.approvalId] = [];
    acc[link.approvalId].push(link.taskId);
    return acc;
  }, {});

  return rows.map((row) => ({
    ...row.approval,
    projectGoal: row.projectGoal,
    taskIds: taskIdsByApproval[row.approval.id] || [],
  }));
}

export async function getApprovalDetail(companyId: string, approvalId: string) {
  const [approval] = await db.select().from(approvals).where(and(
    eq(approvals.companyId, companyId),
    eq(approvals.id, approvalId),
  )).limit(1);

  if (!approval) return null;

  const links = await db.select().from(approvalTaskLinks).where(eq(approvalTaskLinks.approvalId, approvalId));
  const linkedTaskIds = links.map((link) => link.taskId);
  const linkedTasks = linkedTaskIds.length > 0
    ? await db.select().from(tasks).where(inArray(tasks.id, linkedTaskIds))
    : [];

  return {
    approval,
    tasks: linkedTasks,
  };
}

export async function taskHasPendingApproval(companyId: string, taskId: string) {
  const rows = await db.select({
    approvalId: approvalTaskLinks.approvalId,
  }).from(approvalTaskLinks)
    .innerJoin(approvals, eq(approvals.id, approvalTaskLinks.approvalId))
    .where(and(
      eq(approvalTaskLinks.companyId, companyId),
      eq(approvalTaskLinks.taskId, taskId),
      eq(approvals.status, "pending"),
    ))
    .limit(1);

  return rows.length > 0;
}

export async function getLatestPendingApproval(companyId: string, taskId: string) {
  const [approval] = await db.select({
    id: approvals.id,
    status: approvals.status,
    rationale: approvals.rationale,
    confidence: approvals.confidence,
  }).from(approvalTaskLinks)
    .innerJoin(approvals, eq(approvals.id, approvalTaskLinks.approvalId))
    .where(and(
      eq(approvalTaskLinks.companyId, companyId),
      eq(approvalTaskLinks.taskId, taskId),
      eq(approvals.status, "pending"),
    ))
    .orderBy(desc(approvals.requestedAt))
    .limit(1);

  return approval || null;
}
