import { randomUUID } from "crypto";
import { and, desc, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import { approvalTaskLinks, approvals, projects, taskEvents, tasks } from "@/db/schema";
import { broadcastMcpEvent } from "./pubsub";
import { TASK_STATES } from "./task-state";
import { notifyApprovalRequested } from "./notifications";
import {
  approvalDecisionMessage,
  ApprovalDecision,
  EXPIRED_RESOLUTION_NOTE,
  EXTERNAL_APPROVAL_TTL_MS,
  EXTERNAL_ACTION_TYPES,
  resolutionTaskState,
} from "./approval-status";

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
  status: ApprovalDecision;
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

  const linkedTaskRows = await loadLinkedTasks(input.companyId, approval.id);
  const taskIds = linkedTaskRows.map((row) => row.task.id);

  // Approving "close this task" closes it. Approving any other action (send,
  // spend, publish, delete) means "go ahead": the task goes back to work.
  // A rejection returns it to the agent to revise. A dismissal (and an expiry,
  // resolved the same way by expireStaleApprovals) leaves the linked task
  // exactly where it is: the action is obsolete, so there is nothing to rework
  // and nothing to complete, and the least-destructive path is no change.
  const nextState = resolutionTaskState(input.status, approval.actionType);

  if (nextState) {
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
  }

  await broadcastMcpEvent(input.companyId, {
    type: "approval_updated",
    approval,
    taskIds,
  });
  await tellAgentAboutDecision(input.companyId, approval, linkedTaskRows.map((r) => r.task));

  return approval;
}

/** The linked tasks of an approval, with their projects, for refs and effects. */
async function loadLinkedTasks(companyId: string, approvalId: string) {
  const linked = await db.select({
    taskId: approvalTaskLinks.taskId,
  }).from(approvalTaskLinks).where(eq(approvalTaskLinks.approvalId, approvalId));

  const taskIds = linked.map((item) => item.taskId);
  if (taskIds.length === 0) return [];

  return db.select({
    task: tasks,
    project: projects,
  }).from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(
      eq(tasks.companyId, companyId),
      inArray(tasks.id, taskIds),
    ));
}

/** Approvals expired per sweep tick; a backlog drains over several ticks. */
const EXPIRE_BATCH_SIZE = 200;

/**
 * Expire pending approvals of external actions that have waited longer than
 * {@link EXTERNAL_APPROVAL_TTL_MS}. A stale "send / publish / spend / delete"
 * must never be acted on just because a human pressed the one button the UI
 * offered days later. Runs from the periodic sweep (see lifecycle.ts); the
 * update is guarded on `pending`, so a concurrent human decision wins and a
 * repeat pass is a no-op. Returns how many approvals expired.
 */
export async function expireStaleApprovals(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EXTERNAL_APPROVAL_TTL_MS);
  const candidates = await db.select().from(approvals).where(and(
    eq(approvals.status, "pending"),
    inArray(approvals.actionType, [...EXTERNAL_ACTION_TYPES]),
    lt(approvals.requestedAt, cutoff),
  )).orderBy(approvals.requestedAt).limit(EXPIRE_BATCH_SIZE);

  let expired = 0;
  for (const candidate of candidates) {
    // One failing row (notification, broadcast) must not stop the rest of the batch.
    try {
      const [approval] = await db.update(approvals).set({
        status: "expired",
        resolverUserId: null,
        resolutionNote: EXPIRED_RESOLUTION_NOTE,
        resolvedAt: now,
      }).where(and(
        eq(approvals.id, candidate.id),
        eq(approvals.companyId, candidate.companyId),
        eq(approvals.status, "pending"),
      )).returning();

      if (!approval) continue;
      expired += 1;

      const linkedTaskRows = await loadLinkedTasks(candidate.companyId, approval.id);
      await broadcastMcpEvent(candidate.companyId, {
        type: "approval_updated",
        approval,
        taskIds: linkedTaskRows.map((row) => row.task.id),
      });
      await tellAgentAboutDecision(candidate.companyId, approval, linkedTaskRows.map((r) => r.task));
    } catch (error) {
      console.error(`[approvals] failed to expire approval ${candidate.id}:`, error);
    }
  }

  return expired;
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
    const message = approvalDecisionMessage({
      status: approval.status as ApprovalDecision | "expired",
      actionType: approval.actionType,
      refs,
      note: approval.resolutionNote,
    });
    await appendThreadMessage({
      companyId,
      threadId: thread.id,
      senderType: "system",
      targetAgentId: agentId,
      text: message.text,
      // Queued (the runtime acts on it) unless there is nothing left to do.
      deliveryState: message.deliveryState,
      metadataJson: { approvalDecision: approval.status, approvalId: approval.id },
    });
  } catch (error) {
    console.warn("[approvals] could not tell the agent:", error instanceof Error ? error.message : error);
  }
}
