import { and, count, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { Pool } from "pg";
import { db } from "@/db";
import { agentSessions, agents, tasks, threadMessages } from "@/db/schema";
import { notifyAgentDown } from "./notifications";
import { runDailyRoutines } from "./agent-routines";
import { SLA_TRACKED_TASK_STATES } from "./task-state";
import { broadcastMcpEvent } from "./pubsub";

const CHECKIN_DEADLINE_MS = 30_000;
const LIFECYCLE_INTERVAL_MS = 15_000;
const ADVISORY_LOCK_ID = 20261011;
const MAX_WAKE_ATTEMPTS = 3;
/** Runtimes heartbeat every ~60s; this long without one means the agent is down. */
export const AGENT_OFFLINE_AFTER_MS = 5 * 60 * 1000;

let isLifecycleMonitorRunning = false;
let lastRoutineCheck = 0;

const pool = new Pool({
  connectionString: process.env.POSTGRES_CONNECTION_STRING,
});

export function nextCheckinDeadline(from = new Date()) {
  return new Date(from.getTime() + CHECKIN_DEADLINE_MS);
}

export function startLifecycleMonitor() {
  if (isLifecycleMonitorRunning) return;
  isLifecycleMonitorRunning = true;
  console.log("Starting Emperor Claw lifecycle monitor...");
  void runLifecycleMonitor();
  setInterval(() => {
    void runLifecycleMonitor();
  }, LIFECYCLE_INTERVAL_MS);
}

async function runLifecycleMonitor() {
  const client = await pool.connect();
  try {
    const lockRes = await client.query(
      "SELECT pg_try_advisory_lock($1) as locked",
      [ADVISORY_LOCK_ID],
    );
    if (!lockRes.rows[0].locked) return;

    const now = new Date();
    await markSilentAgentsOffline(now);
    // The daily agent review: checked about once a minute, sent once per day.
    if (now.getTime() - lastRoutineCheck >= 60_000) {
      lastRoutineCheck = now.getTime();
      await runDailyRoutines(now).catch((error) => console.error("Daily review failed:", error));
    }
    const staleSessions = await db.select().from(agentSessions).where(and(
      or(
        eq(agentSessions.status, "starting"),
        eq(agentSessions.status, "active"),
        eq(agentSessions.status, "degraded"),
      ),
      lt(agentSessions.checkinDeadlineAt, now),
      isNull(agentSessions.endedAt),
    ));

    for (const session of staleSessions) {
      if ((session.wakeAttempts || 0) + 1 >= (session.maxWakeAttempts || MAX_WAKE_ATTEMPTS)) {
        const [updatedSession] = await db.update(agentSessions).set({
          status: "degraded",
          checkinDeadlineAt: null,
          wakeAttempts: session.maxWakeAttempts || MAX_WAKE_ATTEMPTS,
          lastProvisionError: "Agent did not check in before the deadline.",
        }).where(eq(agentSessions.id, session.id)).returning();

        const activeHealthySessions = await db.select({ id: agentSessions.id }).from(agentSessions).where(and(
          eq(agentSessions.agentId, session.agentId),
          eq(agentSessions.companyId, session.companyId),
          eq(agentSessions.status, "active"),
          isNull(agentSessions.endedAt),
        )).limit(1);

        if (activeHealthySessions.length === 0) {
          await db.update(agents).set({
            status: "offline",
          }).where(and(eq(agents.id, session.agentId), eq(agents.companyId, session.companyId)));
        }

        await broadcastMcpEvent(session.companyId, {
          type: "runtime_session_degraded",
          session: updatedSession,
        });
        continue;
      }

      const [updatedSession] = await db.update(agentSessions).set({
        status: "degraded",
        wakeAttempts: (session.wakeAttempts || 0) + 1,
        checkinDeadlineAt: nextCheckinDeadline(now),
        lastWakeAt: now,
        lastProvisionError: `Check-in deadline missed. Retry ${(session.wakeAttempts || 0) + 1}/${session.maxWakeAttempts || MAX_WAKE_ATTEMPTS}.`,
      }).where(eq(agentSessions.id, session.id)).returning();

      await broadcastMcpEvent(session.companyId, {
        type: "runtime_checkin_retry",
        session: updatedSession,
      });
    }
  } catch (error) {
    console.error("Lifecycle monitor error:", error);
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]);
    } catch (unlockError) {
      console.error("Lifecycle unlock error:", unlockError);
    }
    client.release();
  }
}

/**
 * Agents that stopped heartbeating are offline. Without this, an agent whose
 * runtime died kept showing "online" forever. When it goes down with work
 * waiting (open tasks, or messages addressed to it), owners and admins are
 * notified once.
 */
export async function markSilentAgentsOffline(now = new Date()) {
    const cutoff = new Date(now.getTime() - AGENT_OFFLINE_AFTER_MS);
    const silent = await db.update(agents).set({ status: "offline" }).where(and(
        eq(agents.status, "online"),
        isNull(agents.deletedAt),
        or(isNull(agents.lastSeenAt), lt(agents.lastSeenAt, cutoff)),
        // Freshly created agents get a grace period before their first heartbeat.
        lt(agents.createdAt, cutoff),
    )).returning({ id: agents.id, name: agents.name, companyId: agents.companyId });

    for (const agent of silent) {
        await broadcastMcpEvent(agent.companyId, { type: "agent_status", agentId: agent.id, status: "offline" });
        const [[openTasks], [waiting]] = await Promise.all([
            db.select({ value: count() }).from(tasks).where(and(
                eq(tasks.companyId, agent.companyId),
                eq(tasks.assignedAgentId, agent.id),
                inArray(tasks.state, [...SLA_TRACKED_TASK_STATES]),
                isNull(tasks.deletedAt),
            )),
            db.select({ value: count() }).from(threadMessages).where(and(
                eq(threadMessages.companyId, agent.companyId),
                eq(threadMessages.targetAgentId, agent.id),
                eq(threadMessages.senderType, "human"),
                inArray(threadMessages.deliveryState, ["queued", "seen", "acting"]),
            )),
        ]);
        const pending = { openTasks: Number(openTasks?.value) || 0, waitingMessages: Number(waiting?.value) || 0 };
        if (pending.openTasks + pending.waitingMessages > 0) await notifyAgentDown(agent.companyId, agent, pending);
    }
    return silent.length;
}

/**
 * Any call from an agent's runtime proves it is alive — not only explicit
 * heartbeats. A long turn sends typing/status updates but no heartbeat for
 * minutes, and must not read as "down". Cheap: one indexed UPDATE that only
 * writes when the last sign of life is older than 30 seconds.
 */
export async function touchAgentLiveness(companyId: string, agentId: string) {
    try {
        await db.update(agents).set({ lastSeenAt: new Date(), status: "online" }).where(and(
            eq(agents.id, agentId),
            eq(agents.companyId, companyId),
            isNull(agents.deletedAt),
            or(isNull(agents.lastSeenAt), lt(agents.lastSeenAt, new Date(Date.now() - 30_000))),
        ));
    } catch {
        /* liveness is best-effort */
    }
}
