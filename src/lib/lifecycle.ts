import { and, eq, isNull, lt, or } from "drizzle-orm";
import { Pool } from "pg";
import { db } from "@/db";
import { agentSessions, agents } from "@/db/schema";
import { broadcastMcpEvent } from "./pubsub";

const CHECKIN_DEADLINE_MS = 30_000;
const LIFECYCLE_INTERVAL_MS = 15_000;
const ADVISORY_LOCK_ID = 20261011;
const MAX_WAKE_ATTEMPTS = 3;

let isLifecycleMonitorRunning = false;

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
