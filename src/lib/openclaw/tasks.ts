import { randomUUID } from "crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agents,
  projects,
  recurringTaskDefinitions,
  taskEvents,
  tasks,
} from "@/db/schema";
import { createApprovalRequest, getLatestPendingApproval, taskHasPendingApproval } from "@/lib/approvals";
import { resolveAgentId } from "@/lib/mcp";
import { validateTaskStateTransition } from "@/lib/project-workflow";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { normalizeTaskState, TASK_STATES, type TaskState } from "@/lib/task-state";

type ClaimTaskInput = {
  companyId: string;
  agentId: string;
  strictOwnerRole?: boolean;
  allowedRoles?: string[];
};

type CreateTaskInput = {
  companyId: string;
  projectId: string;
  taskType: string;
  templateVersion?: string | null;
  contractVersion?: string | null;
  inputJson?: Record<string, unknown> | null;
  priority?: number;
  proofRequired?: boolean;
  humanApprovalRequired?: boolean;
  proofTypesJson?: unknown;
  blockedByTaskIds?: string[];
  taskKind?: string;
  recurringTaskDefinitionId?: string | null;
  source?: string;
};

type FinalizeTaskInput = {
  companyId: string;
  taskId: string;
  agentId: string;
  state: unknown;
  outputJson?: unknown;
  comment?: string | null;
  approvalRationale?: string | null;
  confidence?: number;
};

type AssignTaskInput = {
  companyId: string;
  taskId: string;
  agentId: string;
  mode?: "assign" | "claim";
};

type UpdateTaskInput = {
  companyId: string;
  taskId: string;
  title?: string;
  goal?: string;
  priority?: number;
  assignedAgentId?: string | null;
  state?: unknown;
  inputJson?: Record<string, unknown> | null;
};

export async function claimNextTaskForAgent(input: ClaimTaskInput) {
  const strictOwnerRole = input.strictOwnerRole !== false;
  const allowedRoles = Array.isArray(input.allowedRoles) ? input.allowedRoles : [];
  const internalAgentId = await resolveAgentId(input.companyId, input.agentId);

  const [agent] = await db.select({
    id: agents.id,
    role: agents.role,
  }).from(agents).where(
    and(eq(agents.companyId, input.companyId), eq(agents.id, internalAgentId), isNull(agents.deletedAt)),
  ).limit(1);

  if (!agent) {
    throw new Error("Agent not found");
  }

  const agentRole = agent.role || null;
  if (allowedRoles.length > 0 && (!agentRole || !allowedRoles.includes(agentRole))) {
    return { message: "No tasks available for this role policy", task: null };
  }

  const result = await db.execute(sql`
    UPDATE tasks
    SET
      state = ${TASK_STATES.inProgress},
      assigned_agent_id = ${internalAgentId},
      lease_owner = ${input.agentId},
      lease_until = NOW() + INTERVAL '10 minutes',
      processing_started_at = NOW(),
      updated_at = NOW()
    WHERE id = (
      SELECT t.id FROM tasks t
      WHERE t.company_id = ${input.companyId}
        AND t.state = ${TASK_STATES.inbox}
        AND t.deleted_at IS NULL
        AND (
          ${strictOwnerRole === false} = true
          OR COALESCE(t.input_json->>'ownerRole', '') = ''
          OR t.input_json->>'ownerRole' = COALESCE(${agentRole}, '')
        )
        AND (
          jsonb_array_length(t.blocked_by_task_ids) = 0
          OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(t.blocked_by_task_ids) AS blocked_id
            JOIN tasks b ON b.id = blocked_id::uuid
            WHERE b.state != 'done'
          )
        )
        AND (
          COALESCE((
            SELECT COUNT(DISTINCT t2.assigned_agent_id)
            FROM tasks t2
            WHERE t2.company_id = t.company_id
              AND t2.project_id = t.project_id
              AND t2.state = ${TASK_STATES.inProgress}
              AND t2.assigned_agent_id IS NOT NULL
          ), 0) < COALESCE((
            SELECT p.max_active_agents
            FROM projects p
            WHERE p.id = t.project_id
          ), 9999)
        )
      ORDER BY t.priority DESC, t.created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *;
  `);

  if (!result.rows || result.rows.length === 0) {
    return { message: "No tasks available", task: null };
  }

  const task = result.rows[0];
  await db.insert(taskEvents).values({
    companyId: input.companyId,
    taskId: String(task.id),
    eventType: "task_claimed",
    actorType: "agent",
    actorId: internalAgentId,
  });

  await broadcastMcpEvent(input.companyId, { type: "task_updated", task });
  return { message: "Task claimed successfully", task };
}

export async function assignTaskToAgent(input: AssignTaskInput) {
  const internalAgentId = await resolveAgentId(input.companyId, input.agentId);
  const mode = input.mode === "claim" ? "claim" : "assign";

  const [existingTask] = await db.select().from(tasks).where(
    and(eq(tasks.id, input.taskId), eq(tasks.companyId, input.companyId), isNull(tasks.deletedAt)),
  ).limit(1);

  if (!existingTask) {
    return { status: 404 as const, error: "Task not found" };
  }

  const state = mode === "claim" ? TASK_STATES.inProgress : existingTask.state;
  const now = new Date();
  const leaseUntil = mode === "claim" ? new Date(now.getTime() + 10 * 60 * 1000) : existingTask.leaseUntil;

  const [task] = await db.update(tasks).set({
    assignedAgentId: internalAgentId,
    state,
    leaseOwner: mode === "claim" ? input.agentId : existingTask.leaseOwner,
    leaseUntil,
    processingStartedAt: mode === "claim" ? (existingTask.processingStartedAt || now) : existingTask.processingStartedAt,
    updatedAt: now,
  }).where(
    and(eq(tasks.id, input.taskId), eq(tasks.companyId, input.companyId)),
  ).returning();

  await db.insert(taskEvents).values({
    companyId: input.companyId,
    taskId: input.taskId,
    eventType: mode === "claim" ? "task_claimed" : "task_assigned",
    actorType: "agent",
    actorId: internalAgentId,
    payloadJson: {
      mode,
      assignedAgentId: internalAgentId,
      previousState: existingTask.state,
      nextState: task.state,
    },
  });

  await broadcastMcpEvent(input.companyId, { type: "task_updated", task });
  return { status: 200 as const, task };
}

export async function updateTaskForCompany(input: UpdateTaskInput) {
  const [existingTask] = await db.select().from(tasks).where(
    and(eq(tasks.id, input.taskId), eq(tasks.companyId, input.companyId), isNull(tasks.deletedAt)),
  ).limit(1);

  if (!existingTask) {
    return { status: 404 as const, error: "Task not found" };
  }

  let resolvedAssignedAgentId = existingTask.assignedAgentId;
  if (typeof input.assignedAgentId === "string" && input.assignedAgentId.trim()) {
    resolvedAssignedAgentId = await resolveAgentId(input.companyId, input.assignedAgentId.trim());
  } else if (input.assignedAgentId === null) {
    resolvedAssignedAgentId = null;
  }

  const normalizedState = input.state === undefined ? existingTask.state : normalizeTaskState(input.state);
  if (input.state !== undefined && !normalizedState) {
    return { status: 400 as const, error: "Invalid state" };
  }

  const currentInput = (existingTask.inputJson && typeof existingTask.inputJson === "object") ? existingTask.inputJson as Record<string, unknown> : {};
  const nextInputJson = input.inputJson ? { ...currentInput, ...input.inputJson } : currentInput;
  const nextTitle = input.title ?? (typeof currentInput.title === "string" ? currentInput.title : null);
  const nextGoal = input.goal ?? (typeof currentInput.goal === "string" ? currentInput.goal : null);

  const [task] = await db.update(tasks).set({
    priority: typeof input.priority === "number" ? input.priority : existingTask.priority,
    assignedAgentId: resolvedAssignedAgentId,
    state: normalizedState || existingTask.state,
    inputJson: {
      ...nextInputJson,
      ...(nextTitle ? { title: nextTitle } : {}),
      ...(nextGoal ? { goal: nextGoal } : {}),
    },
    updatedAt: new Date(),
  }).where(
    and(eq(tasks.id, input.taskId), eq(tasks.companyId, input.companyId)),
  ).returning();

  await db.insert(taskEvents).values({
    companyId: input.companyId,
    taskId: input.taskId,
    eventType: "task_updated",
    actorType: "system",
    payloadJson: {
      title: input.title,
      goal: input.goal,
      priority: input.priority,
      assignedAgentId: input.assignedAgentId,
      state: normalizedState,
    },
  });

  await broadcastMcpEvent(input.companyId, { type: "task_updated", task });
  return { status: 200 as const, task };
}

export async function createTaskForProject(input: CreateTaskInput) {
  const [project] = await db.select().from(projects).where(
    and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId), isNull(projects.deletedAt)),
  ).limit(1);

  if (!project) {
    throw new Error("RELATIONSHIP_VIOLATION");
  }

  const [task] = await db.insert(tasks).values({
    id: randomUUID(),
    companyId: input.companyId,
    projectId: input.projectId,
    recurringTaskDefinitionId: input.recurringTaskDefinitionId || null,
    taskKind: input.taskKind || "standard",
    taskType: input.taskType,
    templateVersion: input.templateVersion || null,
    contractVersion: input.contractVersion || null,
    state: TASK_STATES.inbox,
    priority: input.priority || 0,
    proofRequired: Boolean(input.proofRequired),
    humanApprovalRequired: typeof input.humanApprovalRequired === "boolean"
      ? input.humanApprovalRequired
      : Boolean(project.requireApprovalForDone),
    proofTypesJson: input.proofTypesJson ?? [],
    inputJson: input.inputJson || {},
    blockedByTaskIds: input.blockedByTaskIds || [],
  }).returning();

  await db.insert(taskEvents).values({
    companyId: input.companyId,
    taskId: task.id,
    eventType: "task_generated",
    actorType: "system",
    payloadJson: {
      source: input.source || "mcp_api",
      recurringTaskDefinitionId: input.recurringTaskDefinitionId || null,
    },
  });

  await broadcastMcpEvent(input.companyId, { type: "new_task", task });
  return { task, project };
}

export async function finalizeTaskForAgent(input: FinalizeTaskInput) {
  const nextState = normalizeTaskState(input.state);
  if (!nextState) {
    return { status: 400 as const, error: "Invalid state" };
  }

  const internalAgentId = await resolveAgentId(input.companyId, input.agentId);
  const [existingTask] = await db.select().from(tasks).where(
    and(eq(tasks.id, input.taskId), eq(tasks.companyId, input.companyId)),
  ).limit(1);

  if (!existingTask) {
    return { status: 404 as const, error: "Task not found" };
  }

  if (existingTask.assignedAgentId !== internalAgentId) {
    return { status: 409 as const, error: "Only the assigned agent can complete this task" };
  }

  const [project] = await db.select().from(projects).where(
    and(eq(projects.id, existingTask.projectId), eq(projects.companyId, input.companyId)),
  ).limit(1);

  if (!project) {
    return { status: 404 as const, error: "Project not found" };
  }

  const hasPendingApproval = await taskHasPendingApproval(input.companyId, input.taskId);
  const transitionError = validateTaskStateTransition({
    project,
    task: existingTask,
    requestedState: nextState,
    actorAgentId: internalAgentId,
    hasPendingApproval,
    comment: input.comment,
  });

  if (transitionError) {
    return { status: 409 as const, error: transitionError };
  }

  if (
    nextState === TASK_STATES.done &&
    (existingTask.humanApprovalRequired || project.requireApprovalForDone)
  ) {
    const approval = await createApprovalRequest({
      companyId: input.companyId,
      projectId: project.id,
      taskIds: [input.taskId],
      requesterAgentId: internalAgentId,
      rationale: input.approvalRationale || input.comment || `Approval requested to complete task ${input.taskId}.`,
      confidence: input.confidence || 0,
      actionType: "task_done",
      metadataJson: {
        requestedState: nextState,
        taskType: existingTask.taskType,
      },
    });

    return {
      status: 409 as const,
      error: "Task requires approval before done",
      approval: approval || await getLatestPendingApproval(input.companyId, input.taskId),
    };
  }

  const [task] = await db.update(tasks).set({
    state: nextState,
    outputJson: input.outputJson ?? existingTask.outputJson,
    updatedAt: new Date(),
    leaseOwner: null,
    leaseUntil: null,
  }).where(
    and(eq(tasks.id, input.taskId), eq(tasks.companyId, input.companyId)),
  ).returning();

  await db.insert(taskEvents).values({
    companyId: input.companyId,
    taskId: input.taskId,
    eventType: `task_${nextState}`,
    actorType: "agent",
    actorId: internalAgentId,
    payloadJson: {
      state: nextState,
      output: input.outputJson ?? null,
      comment: input.comment || null,
    },
  });

  await broadcastMcpEvent(input.companyId, { type: "task_updated", task });
  return { status: 200 as const, task };
}

export async function listTasksForCompany(input: {
  companyId: string;
  limit: number;
  state?: string | null;
  projectId?: string | null;
}) {
  const conditions = [
    eq(tasks.companyId, input.companyId),
    isNull(tasks.deletedAt),
  ];

  if (input.state) {
    const normalized = normalizeTaskState(input.state);
    if (!normalized) {
      throw new Error("Invalid state");
    }
    conditions.push(eq(tasks.state, normalized));
  }

  if (input.projectId) {
    conditions.push(eq(tasks.projectId, input.projectId));
  }

  return db.select().from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt))
    .limit(input.limit);
}

export async function listRecurringTaskDefinitionsForProject(companyId: string, projectId: string) {
  return db.select().from(recurringTaskDefinitions).where(and(
    eq(recurringTaskDefinitions.companyId, companyId),
    eq(recurringTaskDefinitions.projectId, projectId),
    isNull(recurringTaskDefinitions.deletedAt),
  )).orderBy(desc(recurringTaskDefinitions.createdAt));
}

export async function getRecurringTaskDefinitionForProject(companyId: string, projectId: string, recurringTaskId: string) {
  const [definition] = await db.select().from(recurringTaskDefinitions).where(and(
    eq(recurringTaskDefinitions.companyId, companyId),
    eq(recurringTaskDefinitions.projectId, projectId),
    eq(recurringTaskDefinitions.id, recurringTaskId),
    isNull(recurringTaskDefinitions.deletedAt),
  )).limit(1);
  return definition || null;
}

export async function createRecurringTaskDefinition(input: {
  companyId: string;
  projectId: string;
  agentId?: string | null;
  name: string;
  taskType: string;
  cronExpression?: string | null;
  payloadJson?: Record<string, unknown> | null;
  priority?: number;
  proofRequired?: boolean;
  humanApprovalRequired?: boolean;
  proofTypesJson?: unknown;
  nextRunAt?: Date | null;
}) {
  const internalAgentId = input.agentId ? await resolveAgentId(input.companyId, input.agentId) : null;
  const [definition] = await db.insert(recurringTaskDefinitions).values({
    id: randomUUID(),
    companyId: input.companyId,
    projectId: input.projectId,
    createdByAgentId: internalAgentId,
    name: input.name,
    taskType: input.taskType,
    cronExpression: input.cronExpression || null,
    payloadJson: input.payloadJson || {},
    priority: input.priority || 0,
    proofRequired: Boolean(input.proofRequired),
    humanApprovalRequired: Boolean(input.humanApprovalRequired),
    proofTypesJson: input.proofTypesJson ?? [],
    nextRunAt: input.nextRunAt || null,
  }).returning();

  await broadcastMcpEvent(input.companyId, {
    type: "recurring_task_definition_created",
    definition,
  });

  return definition;
}

export async function updateRecurringTaskDefinition(input: {
  companyId: string;
  projectId: string;
  recurringTaskId: string;
  patch: Partial<{
    name: string;
    taskType: string;
    cronExpression: string | null;
    payloadJson: Record<string, unknown>;
    priority: number;
    proofRequired: boolean;
    humanApprovalRequired: boolean;
    proofTypesJson: unknown;
    active: boolean;
    nextRunAt: Date | null;
  }>;
}) {
  const existing = await getRecurringTaskDefinitionForProject(input.companyId, input.projectId, input.recurringTaskId);
  if (!existing) return null;

  const [definition] = await db.update(recurringTaskDefinitions).set({
    name: input.patch.name ?? existing.name,
    taskType: input.patch.taskType ?? existing.taskType,
    cronExpression: input.patch.cronExpression === undefined ? existing.cronExpression : input.patch.cronExpression,
    payloadJson: input.patch.payloadJson ?? existing.payloadJson,
    priority: input.patch.priority ?? existing.priority,
    proofRequired: input.patch.proofRequired ?? existing.proofRequired,
    humanApprovalRequired: input.patch.humanApprovalRequired ?? existing.humanApprovalRequired,
    proofTypesJson: input.patch.proofTypesJson ?? existing.proofTypesJson,
    active: input.patch.active ?? existing.active,
    nextRunAt: input.patch.nextRunAt === undefined ? existing.nextRunAt : input.patch.nextRunAt,
    updatedAt: new Date(),
  }).where(eq(recurringTaskDefinitions.id, existing.id)).returning();

  await broadcastMcpEvent(input.companyId, {
    type: "recurring_task_definition_updated",
    definition,
  });

  return definition;
}

export async function archiveRecurringTaskDefinition(companyId: string, projectId: string, recurringTaskId: string) {
  const existing = await getRecurringTaskDefinitionForProject(companyId, projectId, recurringTaskId);
  if (!existing) return null;

  const [definition] = await db.update(recurringTaskDefinitions).set({
    active: false,
    deletedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(recurringTaskDefinitions.id, existing.id)).returning();

  await broadcastMcpEvent(companyId, {
    type: "recurring_task_definition_archived",
    definition,
  });

  return definition;
}

export async function spawnRecurringTaskInstance(input: {
  companyId: string;
  projectId: string;
  recurringTaskId: string;
  source?: string;
}) {
  const definition = await getRecurringTaskDefinitionForProject(input.companyId, input.projectId, input.recurringTaskId);
  if (!definition) {
    throw new Error("Recurring task definition not found");
  }

  const { task } = await createTaskForProject({
    companyId: input.companyId,
    projectId: input.projectId,
    taskType: definition.taskType,
    priority: definition.priority,
    proofRequired: definition.proofRequired,
    humanApprovalRequired: definition.humanApprovalRequired,
    proofTypesJson: definition.proofTypesJson,
    inputJson: definition.payloadJson as Record<string, unknown>,
    recurringTaskDefinitionId: definition.id,
    taskKind: "standard",
    source: input.source || "recurring_task_spawn",
  });

  const [updatedDefinition] = await db.update(recurringTaskDefinitions).set({
    lastSpawnedTaskId: task.id,
    lastRunAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(recurringTaskDefinitions.id, definition.id)).returning();

  await broadcastMcpEvent(input.companyId, {
    type: "recurring_task_spawned",
    definition: updatedDefinition,
    task,
  });

  return { definition: updatedDefinition, task };
}

export function parseRequestedTaskState(input: unknown): TaskState | null {
  return normalizeTaskState(input);
}
