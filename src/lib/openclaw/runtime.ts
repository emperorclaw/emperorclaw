import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentSessions, agents, tasks } from "@/db/schema";
import { resolveAgentId } from "@/lib/mcp";
import { nextCheckinDeadline } from "@/lib/lifecycle";
import { TASK_STATES } from "@/lib/task-state";
import { normalizeLeaseSession } from "@/lib/openclaw/tasks";

/** How long one heartbeat's lease marker is good for (an explicit lease defaults to 900 s). */
export const HEARTBEAT_LEASE_SECONDS = 600;

export async function acknowledgeAgentHeartbeat(input: {
  companyId: string;
  agentId: string;
  currentLoad: number;
  /** The caller's own lease session id, when the bridge knows it. */
  session?: string | null;
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

  // Renew only the holds this heartbeat can speak for. Before this check the
  // write touched every in_progress task of the agent, so a session that died
  // holding a lease kept it alive for as long as any other session of the same
  // agent kept beating: the lease never expired, the watchdog never reclaimed
  // the task, and a second session got 409 forever (task 9252039B).
  //
  //   - `lease_owner IS NULL`: nobody claimed it; the platform marker that
  //     keeps the watchdog from yanking a task a live agent is working on.
  //   - a named `session` that is the holder: `(lease_owner, lease_session)`
  //     match. Any other session of the same agent is left untouched.
  //
  // `updatedAt` is deliberately NOT stamped here: it means "last real change"
  // (state, note, assignment), which is the signal the stall sweep reads.
  // Bumping it on every beat silently disabled that sweep for every task an
  // online agent held.
  const session = normalizeLeaseSession(input.session);
  const representsHold = session
    ? or(
        isNull(tasks.leaseOwner),
        and(eq(tasks.leaseOwner, internalAgentId), eq(tasks.leaseSession, session)),
      )
    : isNull(tasks.leaseOwner);

  await db.update(tasks).set({
    leaseUntil: sql`NOW() + make_interval(secs => ${HEARTBEAT_LEASE_SECONDS}::int)`,
  }).where(and(
    eq(tasks.companyId, input.companyId),
    eq(tasks.assignedAgentId, internalAgentId),
    eq(tasks.state, TASK_STATES.inProgress),
    isNull(tasks.deletedAt),
    representsHold,
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
