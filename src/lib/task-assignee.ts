import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { agents, companyMembers, users } from "@/db/schema";
import { resolveAgentId } from "@/lib/mcp";

export type TaskAssignee =
  | { type: "agent"; id: string }
  | { type: "human"; id: string }
  | null;

export type TaskAssigneeColumns = {
  assignedAgentId: string | null;
  assignedMemberId: string | null;
};

export function getTaskAssignee(task: TaskAssigneeColumns): TaskAssignee {
  if (task.assignedMemberId) return { type: "human", id: task.assignedMemberId };
  if (task.assignedAgentId) return { type: "agent", id: task.assignedAgentId };
  return null;
}

export function serializeTaskWithAssignee<T extends TaskAssigneeColumns>(task: T) {
  return {
    ...task,
    assignee: getTaskAssignee(task),
  };
}

function parseTaskAssignee(input: unknown): TaskAssignee {
  if (input === null) return null;
  if (!input || typeof input !== "object") {
    throw new Error("Invalid assignee");
  }

  const candidate = input as { type?: unknown; id?: unknown };
  if (
    (candidate.type !== "agent" && candidate.type !== "human") ||
    typeof candidate.id !== "string" ||
    !candidate.id.trim()
  ) {
    throw new Error("Invalid assignee");
  }

  return { type: candidate.type, id: candidate.id.trim() };
}

export async function resolveTaskAssignee(
  companyId: string,
  input: unknown,
): Promise<TaskAssigneeColumns> {
  const assignee = parseTaskAssignee(input);
  if (!assignee) {
    return { assignedAgentId: null, assignedMemberId: null };
  }

  if (assignee.type === "agent") {
    const agentId = await resolveAgentId(companyId, assignee.id);
    const [agent] = await db.select({ id: agents.id }).from(agents).where(and(
      eq(agents.id, agentId),
      eq(agents.companyId, companyId),
      isNull(agents.deletedAt),
    )).limit(1);

    if (!agent) throw new Error("Agent not found");
    return { assignedAgentId: agent.id, assignedMemberId: null };
  }

  // Human assignment accepts either the company-membership id (the canonical
  // stored reference) or the user id returned by the existing MCP /users API.
  const [member] = await db.select({ id: companyMembers.id }).from(companyMembers)
    .innerJoin(users, eq(users.id, companyMembers.userId))
    .where(and(
      eq(companyMembers.companyId, companyId),
      or(eq(companyMembers.id, assignee.id), eq(companyMembers.userId, assignee.id)),
      isNull(users.deletedAt),
    ))
    .limit(1);

  if (!member) throw new Error("Human assignee not found");
  return { assignedAgentId: null, assignedMemberId: member.id };
}
