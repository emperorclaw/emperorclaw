import { db } from "@/db";
import { lt, and, eq, inArray, isNotNull, isNull, ne, notInArray, or } from "drizzle-orm";
import { tasks, taskEvents, incidents } from "@/db/schema";
import { Pool } from "pg";
import { SLA_TRACKED_TASK_STATES, TASK_STATES } from "./task-state";
import { broadcastMcpEvent } from "./pubsub";
import { notifyIncident } from "@/lib/notifications";

let isWatchdogRunning = false;
const WATCHDOG_INTERVAL_MS = 60000;

const ADVISORY_LOCK_ID = 20261010; // Unique ID for our watchdog lock

// Helper for raw pg connection to hold lock reliably around transaction
const pool = new Pool({
    connectionString: process.env.POSTGRES_CONNECTION_STRING,
});

export function startWatchdog() {
    if (isWatchdogRunning) return;
    isWatchdogRunning = true;
    console.log("Starting Emperor Claw Watchdog...");

    // Run immediately on start, then loop
    runWatchdog();
    setInterval(runWatchdog, WATCHDOG_INTERVAL_MS);
}

async function runWatchdog() {
    const client = await pool.connect();
    try {
        // Attempt to acquire advisory lock
        const lockRes = await client.query("SELECT pg_try_advisory_lock($1) as locked", [ADVISORY_LOCK_ID]);
        if (!lockRes.rows[0].locked) {
            // Another instance holding the lock, skip loop
            return;
        }

        const now = new Date();

        // 0. Resolve our own incidents once their task has moved on. Watchdog
        // SLA/queue incidents are transient signals, not persistent problems:
        // once the task is claimed, done, cancelled, or reassigned they must
        // close themselves instead of lingering and (mis)marking an agent as
        // stuck long after the task moved.
        await resolveOwnStaleIncidents();

        // 1. Reclaim expired leases (Retry / Dead Letter)
        // Canonical in-progress tasks hold leases.
        const expiredTasks = await db.select().from(tasks).where(
            and(eq(tasks.state, TASK_STATES.inProgress), lt(tasks.leaseUntil, now))
        );

        for (const task of expiredTasks) {
            if (task.retries < task.maxRetries) {
                const [updatedTask] = await db.update(tasks).set({
                    state: TASK_STATES.inbox,
                    retries: task.retries + 1,
                    leaseOwner: null,
                    leaseUntil: null,
                    assignedAgentId: null,
                    assignedMemberId: null,
                    updatedAt: new Date(),
                }).where(and(
                    eq(tasks.id, task.id),
                    // Re-check the predicate: the task may have been finalized
                    // between the SELECT and this UPDATE, and must not be
                    // resurrected back into the inbox.
                    eq(tasks.state, TASK_STATES.inProgress),
                    lt(tasks.leaseUntil, now),
                )).returning();

                if (!updatedTask) continue;

                await db.insert(taskEvents).values({
                    companyId: task.companyId,
                    taskId: task.id,
                    eventType: "lease_expired_retry",
                    actorType: "system",
                    payloadJson: { reason: "lease expired, retrying" },
                });

                await broadcastMcpEvent(task.companyId, {
                    type: "task_updated",
                    task: updatedTask,
                });
            } else {
                const [deadLetterTask] = await db.update(tasks).set({
                    state: TASK_STATES.deadLetter,
                    updatedAt: new Date(),
                }).where(and(
                    eq(tasks.id, task.id),
                    eq(tasks.state, TASK_STATES.inProgress),
                    lt(tasks.leaseUntil, now),
                )).returning();

                if (!deadLetterTask) continue;

                await db.insert(taskEvents).values({
                    companyId: task.companyId,
                    taskId: task.id,
                    eventType: "dead_lettered",
                    actorType: "system",
                    payloadJson: { reason: "max retries exceeded" },
                });

                await broadcastMcpEvent(task.companyId, {
                    type: "task_updated",
                    task: deadLetterTask,
                });

                const [incident] = await db.insert(incidents).values({
                    companyId: task.companyId,
                    projectId: task.projectId,
                    taskId: task.id,
                    severity: "high",
                    reasonCode: "max_retries_exceeded",
                    summary: `Task ${task.id} exceeded max retries and was dead-lettered.`,
                }).returning();

                await broadcastMcpEvent(task.companyId, {
                    type: "incident_updated",
                    incident,
                });
                await notifyIncident(task.companyId, incident);
            }
        }

        // 2. Detect SLA breaches
        // Canonical pre-terminal task states remain SLA-tracked.
        const breachedTasks = await db.select().from(tasks).where(
            and(
                inArray(tasks.state, SLA_TRACKED_TASK_STATES),
                lt(tasks.slaDueAt, now),
                isNull(tasks.deletedAt)
            )
        );

        for (const task of breachedTasks) {
            const [existingIncident] = await db.select().from(incidents).where(
                and(
                    eq(incidents.taskId, task.id),
                    eq(incidents.reasonCode, "sla_breach"),
                    eq(incidents.status, "open")
                )
            ).limit(1);

            if (!existingIncident) {
                const [incident] = await db.insert(incidents).values({
                    companyId: task.companyId,
                    projectId: task.projectId,
                    taskId: task.id,
                    severity: "medium",
                    reasonCode: "sla_breach",
                    summary: `Task ${task.id} breached SLA deadline.`,
                }).returning();

                await broadcastMcpEvent(task.companyId, {
                    type: "incident_updated",
                    incident,
                });
                await notifyIncident(task.companyId, incident);
            }
        }

        // 3. Detect unclaimed tasks sitting too long in inbox (>1 hour)
        const UNCLAIMED_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
        const unclaimedThreshold = new Date(now.getTime() - UNCLAIMED_THRESHOLD_MS);
        const staleInboxTasks = await db.select().from(tasks).where(
            and(
                eq(tasks.state, "inbox"),
                lt(tasks.createdAt, unclaimedThreshold),
                isNull(tasks.deletedAt)
            )
        );

        for (const task of staleInboxTasks) {
            const [existingIncident] = await db.select().from(incidents).where(
                and(
                    eq(incidents.taskId, task.id),
                    eq(incidents.reasonCode, "unclaimed_stale"),
                    eq(incidents.status, "open")
                )
            ).limit(1);

            if (!existingIncident) {
                const [incident] = await db.insert(incidents).values({
                    companyId: task.companyId,
                    projectId: task.projectId,
                    taskId: task.id,
                    severity: "low",
                    reasonCode: "unclaimed_stale",
                    summary: `Task ${task.id} has been unclaimed in inbox for over 1 hour.`,
                }).returning();

                await broadcastMcpEvent(task.companyId, {
                    type: "incident_updated",
                    incident,
                });
                await notifyIncident(task.companyId, incident);
            }
        }

    } catch (error) {
        console.error("Watchdog execution error:", error);
    } finally {
        try {
            await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]);
        } catch (unlockErr) {
            console.error("Error releasing lock:", unlockErr);
        }
        client.release();
    }
}

/**
 * Close watchdog-owned incidents (SLA breach / unclaimed queue) whose task no
 * longer matches the condition that created them. Only touches the two
 * reason codes the watchdog itself writes; agent-reported and dead-letter
 * incidents are left alone. Idempotent: the status re-check makes a repeat
 * pass a no-op.
 */
const WATCHDOG_RESOLVABLE = ["sla_breach", "unclaimed_stale"];

export async function resolveOwnStaleIncidents(): Promise<void> {
    // One set-based pass: resolve every open watchdog incident whose task no
    // longer matches the condition that created it. `tasks.id IS NULL` (task
    // hard-deleted) or `tasks.deleted_at` set means the task is gone; an
    // unclaimed notice clears once the task leaves the inbox; an SLA breach
    // clears once the task leaves the SLA-tracked states. Idempotent: the
    // status='open' re-check makes a repeat pass a no-op.
    const stale = db
        .select({ id: incidents.id })
        .from(incidents)
        .leftJoin(tasks, eq(tasks.id, incidents.taskId))
        .where(
            and(
                eq(incidents.status, "open"),
                isNull(incidents.deletedAt),
                isNotNull(incidents.taskId),
                inArray(incidents.reasonCode, WATCHDOG_RESOLVABLE),
                or(
                    isNull(tasks.id),
                    isNotNull(tasks.deletedAt),
                    and(eq(incidents.reasonCode, "unclaimed_stale"), ne(tasks.state, "inbox")),
                    and(eq(incidents.reasonCode, "sla_breach"), notInArray(tasks.state, [...SLA_TRACKED_TASK_STATES])),
                ),
            )
        );

    await db.update(incidents).set({ status: "resolved", resolvedAt: new Date() })
        .where(inArray(incidents.id, stale));
}
