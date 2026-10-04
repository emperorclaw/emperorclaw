import { randomUUID } from "crypto";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { approvalTaskLinks, approvals, projects, taskEvents, tasks } from "@/db/schema";
import { broadcastMcpEvent } from "./pubsub";
import { TASK_STATES } from "./task-state";
import { notifyApprovalRequested } from "./notifications";

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
  await notifyApprovalRequested(input.companyId, approval);

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
    // A decision is final: resolving an already-resolved approval is a no-op.
    eq(approvals.status, "pending"),
  )).returning();

  if (!approval) {
    const [existing] = await db.select().from(approvals).where(and(eq(approvals.companyId, input.companyId), eq(approvals.id, input.approvalId))).limit(1);
    return existing ?? null;
  }

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

  // Approving "close this task" closes it. Approving any other action (send,
  // spend, publish, delete) means "go ahead": the task goes back to work.
  // A rejection always returns it to the agent to revise — never left
  // parked in review with nobody acting on it.
  const nextState = input.status === "approved" && approval.actionType === "task_done" ? TASK_STATES.done : TASK_STATES.inProgress;

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
  await tellAgentAboutDecision(input.companyId, approval, linkedTaskRows.map((r) => r.task));

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

export class ApprovalRequestError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/**
 * An agent asks a person to sign off on tasks (spend money, send something
 * external, publish, delete, or close work that needs approval). Validates
 * the tasks belong to the company and share one project, creates or reuses
 * the pending approval, and moves the tasks to review while they wait.
 */
export async function requestApprovalForTasks(input: {
  companyId: string;
  taskIds: string[];
  requesterAgentId?: string | null;
  rationale?: string | null;
  actionType?: string;
  confidence?: number;
}) {
  const taskIds = [...new Set(input.taskIds.filter((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)))];
  if (taskIds.length === 0) throw new ApprovalRequestError("taskIds are required", 400);
  const rows = await db.select({ id: tasks.id, projectId: tasks.projectId, state: tasks.state }).from(tasks)
    .where(and(eq(tasks.companyId, input.companyId), inArray(tasks.id, taskIds), isNull(tasks.deletedAt)));
  if (rows.length !== taskIds.length) throw new ApprovalRequestError("Task not found", 404);
  const projectIds = [...new Set(rows.map((r) => r.projectId))];
  if (projectIds.length !== 1) throw new ApprovalRequestError("An approval covers tasks of one project", 400);
  if (!input.rationale || !input.rationale.trim()) throw new ApprovalRequestError("Say what needs approval and why (rationale)", 400);

  const approval = await createApprovalRequest({
    companyId: input.companyId,
    projectId: projectIds[0],
    taskIds,
    requesterAgentId: input.requesterAgentId ?? null,
    rationale: input.rationale.trim().slice(0, 2000),
    confidence: input.confidence ?? 0,
    actionType: input.actionType || "task_done",
    metadataJson: { createdBy: "agent_request" },
  });

  // Waiting on a person is the review state.
  await db.update(tasks).set({ state: TASK_STATES.review, updatedAt: new Date() }).where(and(
    eq(tasks.companyId, input.companyId),
    inArray(tasks.id, taskIds),
    ne(tasks.state, TASK_STATES.done),
  ));
  return approval;
}

/**
 * The agent learns the decision right away (it used to find out only when it
 * next looked at the task): a message in its direct thread, addressed to it,
 * with the note and what to do next.
 */
async function tellAgentAboutDecision(companyId: string, approval: typeof approvals.$inferSelect, linked: (typeof tasks.$inferSelect)[]) {
  try {
    const agentId = approval.requesterAgentId ?? linked.find((t) => t.assignedAgentId)?.assignedAgentId ?? null;
    if (!agentId) return;
    const { appendThreadMessage, ensureDirectThread } = await import("./control-plane");
    const thread = await ensureDirectThread(companyId, agentId, null);
    const refs = linked.map((t) => {
      const input = t.inputJson && typeof t.inputJson === "object" ? t.inputJson as Record<string, unknown> : {};
      const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : t.taskType;
      return `[${title.replace(/[[\]]/g, "")}](emperor://task/${t.id})`;
    }).join(", ");
    const approved = approval.status === "approved";
    const next = approved
      ? approval.actionType === "task_done"
        ? "The task is closed. Nothing else to do unless the note asks for it."
        : "Go ahead with it now, then update the task (note what you did, attach the evidence) and close it when its acceptance criteria are met."
      : "Revise according to the note, update the task, and request approval again when it's ready.";
    await appendThreadMessage({
      companyId,
      threadId: thread.id,
      senderType: "system",
      targetAgentId: agentId,
      text: `Approval ${approved ? "granted" : "rejected"} for ${refs}${approval.resolutionNote ? `: "${approval.resolutionNote}"` : "."}\n\n${next}`,
      // Queued (the runtime acts on it) unless there is nothing left to do.
      deliveryState: approved && approval.actionType === "task_done" ? "resolved" : "queued",
      metadataJson: { approvalDecision: approval.status, approvalId: approval.id },
    });
  } catch (error) {
    console.warn("[approvals] could not tell the agent:", error instanceof Error ? error.message : error);
  }
}
