import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  approvalTaskLinks,
  approvals,
  projects,
  tasks,
} from "@/db/schema";
import { normalizeTaskState, TASK_STATES, isTerminalTaskState, type PersistedTaskState, type TaskState } from "./task-state";

export const REVIEW_BUCKETS = {
  approvalNeeded: "approval_needed",
  waitingReview: "waiting_review",
  blocked: "blocked",
  readyToClose: "ready_to_close",
} as const;

export type ReviewBucket =
  (typeof REVIEW_BUCKETS)[keyof typeof REVIEW_BUCKETS];

export type ProjectWorkflowPolicy = typeof projects.$inferSelect;
export type WorkflowTask = typeof tasks.$inferSelect;

export const EXECUTION_STATES = ["queued", "seen", "acting", "resolved"] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export function isTaskBlocked(
  task: Pick<WorkflowTask, "blockedByTaskIds">,
  tasksById: Map<string, Pick<WorkflowTask, "id" | "state">>,
) {
  const blockedIds = Array.isArray(task.blockedByTaskIds)
    ? (task.blockedByTaskIds as string[])
    : [];
  return blockedIds.some((blockedId) => {
    const blockingTask = tasksById.get(blockedId);
    return blockingTask && blockingTask.state !== TASK_STATES.done;
  });
}

export function resolveReviewBucket(input: {
  task: Pick<WorkflowTask, "state" | "blockedByTaskIds">;
  tasksById: Map<string, Pick<WorkflowTask, "id" | "state">>;
  pendingApprovalCount?: number;
  requiresReviewBeforeDone?: boolean;
}) {
  if (isTaskBlocked(input.task, input.tasksById)) {
    return REVIEW_BUCKETS.blocked;
  }
  if ((input.pendingApprovalCount || 0) > 0) {
    return REVIEW_BUCKETS.approvalNeeded;
  }
  if (input.requiresReviewBeforeDone) {
    return REVIEW_BUCKETS.waitingReview;
  }
  return REVIEW_BUCKETS.readyToClose;
}

export function normalizeExecutionState(input: unknown): ExecutionState | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (EXECUTION_STATES.includes(value as ExecutionState)) {
    return value as ExecutionState;
  }
  return null;
}

export function isLeadForProject(project: Pick<ProjectWorkflowPolicy, "leadAgentId">, agentId: string | null) {
  return Boolean(agentId && project.leadAgentId && project.leadAgentId === agentId);
}

export function canWorkerCompleteDirectly(project: Pick<ProjectWorkflowPolicy, "requireApprovalForDone" | "requireReviewBeforeDone" | "onlyLeadCanChangeStatus">) {
  return !project.requireApprovalForDone && !project.requireReviewBeforeDone && !project.onlyLeadCanChangeStatus;
}

export function validateTaskStateTransition(input: {
  project: Pick<ProjectWorkflowPolicy,
    "leadAgentId" |
    "requireApprovalForDone" |
    "requireReviewBeforeDone" |
    "commentRequiredForReview" |
    "blockStatusChangesWithPendingApproval" |
    "onlyLeadCanChangeStatus">;
  task: Pick<WorkflowTask, "state" | "assignedAgentId">;
  requestedState: TaskState;
  actorAgentId: string | null;
  hasPendingApproval?: boolean;
  comment?: string | null;
}) {
  const { project, task, requestedState, actorAgentId } = input;
  const isLead = isLeadForProject(project, actorAgentId);
  const isAssignee = Boolean(actorAgentId && task.assignedAgentId && task.assignedAgentId === actorAgentId);
  const hasPendingApproval = Boolean(input.hasPendingApproval);
  const trimmedComment = input.comment?.trim() || "";

  // Requesting the state the task is already in is a no-op success, not an
  // error: re-saving in_progress (or re-requesting done on a done task) must
  // not trip the source-state rules below.
  if (requestedState === task.state) return null;

  // Terminal states are never reopened — a done or failed task stays closed.
  if (isTerminalTaskState(task.state as PersistedTaskState) && requestedState !== task.state) {
    return "A done or failed task cannot be reopened.";
  }

  // Self-start: the assignee starts only from a queued/assigned state and hands
  // to review only from in_progress. The lead is exempt (it routes and decides).
  if (isAssignee && !isLead) {
    if (requestedState === TASK_STATES.inProgress && task.state !== TASK_STATES.inbox) {
      return "A task can only move to in_progress from a queued or assigned state.";
    }
    if (requestedState === TASK_STATES.review && task.state !== TASK_STATES.inProgress) {
      return "A task can only move to review from in_progress.";
    }
  }

  if (
    project.blockStatusChangesWithPendingApproval &&
    hasPendingApproval &&
    requestedState !== TASK_STATES.review
  ) {
    return "A pending approval blocks this status change.";
  }

  if (requestedState === TASK_STATES.done) {
    if (project.requireApprovalForDone && hasPendingApproval) {
      return "Task has a pending approval and cannot move to done yet.";
    }
    if (project.requireReviewBeforeDone && task.state !== TASK_STATES.review) {
      return "Task must move through review before done.";
    }
    if (project.onlyLeadCanChangeStatus && !isLead) {
      return "Only the project lead can move tasks to done.";
    }
  }

  if (
    requestedState === TASK_STATES.review &&
    project.commentRequiredForReview &&
    trimmedComment.length === 0
  ) {
    return "A review comment is required before moving to review.";
  }

  if (
    project.onlyLeadCanChangeStatus &&
    !isLead &&
    requestedState !== TASK_STATES.review &&
    requestedState !== TASK_STATES.failed &&
    // The assignee still starts its own work: "accept, then set in_progress".
    !(requestedState === TASK_STATES.inProgress && isAssignee)
  ) {
    return "Only the project lead can perform this status transition.";
  }

  if (!isLead && requestedState === TASK_STATES.done && !canWorkerCompleteDirectly(project)) {
    return "Worker agents must move this task to review instead of done.";
  }

  return null;
}

export async function getProjectById(companyId: string, projectId: string) {
  const [project] = await db.select().from(projects).where(
    and(eq(projects.companyId, companyId), eq(projects.id, projectId)),
  ).limit(1);
  return project || null;
}

export async function getPendingApprovalSummaryForTaskIds(companyId: string, taskIds: string[]) {
  if (taskIds.length === 0) {
    return new Map<string, { total: number; pending: number; latestApprovalId: string | null }>();
  }

  const summary = new Map<string, { total: number; pending: number; latestApprovalId: string | null }>();
  const rows = await db.select({
    taskId: approvalTaskLinks.taskId,
    approvalId: approvalTaskLinks.approvalId,
    status: approvals.status,
  }).from(approvalTaskLinks)
    .innerJoin(approvals, eq(approvals.id, approvalTaskLinks.approvalId))
    .where(and(
      eq(approvalTaskLinks.companyId, companyId),
      inArray(approvalTaskLinks.taskId, taskIds),
    ));

  for (const row of rows) {
    const current = summary.get(row.taskId) || {
      total: 0,
      pending: 0,
      latestApprovalId: null,
    };
    current.total += 1;
    if (row.status === "pending") {
      current.pending += 1;
      current.latestApprovalId = row.approvalId;
    }
    summary.set(row.taskId, current);
  }
  return summary;
}

export async function getPendingApprovalForTask(companyId: string, taskId: string) {
  const [link] = await db.select({
    approvalId: approvalTaskLinks.approvalId,
    status: approvals.status,
  }).from(approvalTaskLinks)
    .innerJoin(approvals, eq(approvals.id, approvalTaskLinks.approvalId))
    .where(and(
      eq(approvalTaskLinks.companyId, companyId),
      eq(approvalTaskLinks.taskId, taskId),
      eq(approvals.status, "pending"),
    ))
    .limit(1);

  return link || null;
}

export async function getTasksByIds(taskIds: string[]) {
  if (taskIds.length === 0) return [];
  return db.select().from(tasks).where(inArray(tasks.id, taskIds));
}

export function isRecurringTask(task: Pick<WorkflowTask, "taskKind" | "recurringTaskDefinitionId">) {
  return task.taskKind === "recurrent" || task.taskKind === "recurring";
}

export function normalizeRequestedTaskState(input: unknown) {
  return normalizeTaskState(input);
}

export function isHiddenBoardState(state: PersistedTaskState) {
  return state === TASK_STATES.failed || state === TASK_STATES.deadLetter;
}
