import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentSessions, agents, tasks } from "@/db/schema";
import { resolveAgentId } from "@/lib/mcp";
import { nextCheckinDeadline } from "@/lib/lifecycle";
import { TASK_STATES } from "@/lib/task-state";

export async function acknowledgeAgentHeartbeat(input: {
  companyId: string;
  agentId: string;
  currentLoad: number;
}) {
  const internalAgentId = await resolveAgentId(input.companyId, input.agentId);

  const [agent] = await db.update(agents).set({
    lastSeenAt: new Date(),
    currentLoad: input.currentLoad,
    status: "online",
  }).where(and(
    eq(agents.id, internalAgentId),
    eq(agents.companyId, input.companyId),
    isNull(agents.deletedAt),
  )).returning();

  if (!agent) {
    return null;
  }

  await db.update(tasks).set({
    leaseUntil: sql`NOW() + INTERVAL '10 minutes'`,
    updatedAt: new Date(),
  }).where(and(
    eq(tasks.companyId, input.companyId),
    eq(tasks.assignedAgentId, internalAgentId),
    eq(tasks.state, TASK_STATES.inProgress),
    isNull(tasks.deletedAt),
  ));

  await db.update(agentSessions).set({
    lastHeartbeatAt: new Date(),
    checkinDeadlineAt: nextCheckinDeadline(),
    wakeAttempts: 0,
    lastProvisionError: null,
    status: "active",
  }).where(and(
    eq(agentSessions.companyId, input.companyId),
    eq(agentSessions.agentId, internalAgentId),
    isNull(agentSessions.endedAt),
  ));

  return agent;
}
