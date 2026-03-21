import { db } from "@/db";
import { lt, and, eq, inArray } from "drizzle-orm";
import { tasks, taskEvents, incidents } from "@/db/schema";
import { Pool } from "pg";
import { SLA_TRACKED_TASK_STATES, TASK_STATES } from "./task-state";
import { broadcastMcpEvent } from "./pubsub";

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
        // 1. Reclaim expired leases (Retry / Dead Letter)
        // Canonical in-progress tasks hold leases.
        const expiredTasks = await db.select().from(tasks).where(
            and(eq(tasks.state, TASK_STATES.inProgress), lt(tasks.leaseUntil, now))
        );

        for (const task of expiredTasks) {
            if (task.retries < task.maxRetries) {
                const [updatedTask] = await db.update(tasks).set({
                    state: TASK_STATES.queued,
                    retries: task.retries + 1,
                    leaseOwner: null,
                    leaseUntil: null,
                    assignedAgentId: null,
                    updatedAt: new Date(),
                }).where(eq(tasks.id, task.id)).returning();

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
                }).where(eq(tasks.id, task.id)).returning();

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
            }
        }

        // 2. Detect SLA breaches
        // Canonical pre-terminal task states remain SLA-tracked.
        const breachedTasks = await db.select().from(tasks).where(
            and(
                inArray(tasks.state, SLA_TRACKED_TASK_STATES),
                lt(tasks.slaDueAt, now)
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
