import { and, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentObjectives, agents, messageThreads, threadMessages } from "@/db/schema";
import { isCompanyOwnerOrAdmin } from "@/lib/groups";
import { broadcastMcpEvent } from "@/lib/pubsub";

// Imported dynamically to avoid a static import cycle
// (control-plane -> lifecycle -> this module).
async function ensureDirectThread(companyId: string, agentId: string, userId: string | null) {
    const controlPlane = await import("@/lib/control-plane");
    return controlPlane.ensureDirectThread(companyId, agentId, userId);
}

/**
 * Persistent objectives, owned by Emperor and provider-independent.
 *
 * A background sweep (the lifecycle monitor) posts an ordinary private prompt
 * to the owning agent's direct conversation on a fixed cadence, up to a finite
 * budget. Every runtime already receives normal messages through `/messages/sync`
 * and replies through `/messages/send`, so this works for every provider; the
 * agent reports status back with the authenticated `update_objective` tool (or
 * the matching MCP route), which is bound to its own token.
 *
 * This is the default objective mode. The Hermes-native goal engine is retained
 * only for backwards compatibility: old `runtimeGoalRequest` records stay
 * readable and old `/api/mcp/agents/goals` bridges keep working, but new
 * objectives never depend on a runtime-side goal manager.
 *
 * Privacy and ownership: an objective is started in one human's private
 * conversation with the agent. Only that person (and company owners/admins) may
 * read its text or manage it; everyone else sees a redacted status. An agent
 * may only ever touch its own objective (enforced by company + agent).
 */

export type ObjectiveAction = "start" | "pause" | "resume" | "stop" | "update" | "block" | "complete";
export type ObjectiveStatus = "active" | "paused" | "blocked" | "completed" | "cancelled";

export const OBJECTIVE_STATUSES: readonly ObjectiveStatus[] = ["active", "paused", "blocked", "completed", "cancelled"];
export const OBJECTIVE_ACTIVE_STATUSES: readonly ObjectiveStatus[] = ["active", "paused", "blocked"];

export const OBJECTIVE_MIN_CADENCE_MINUTES = 5;
export const OBJECTIVE_MAX_CADENCE_MINUTES = 7 * 24 * 60; // one week
export const OBJECTIVE_DEFAULT_CADENCE_MINUTES = 60;
export const OBJECTIVE_DEFAULT_MAX_FOLLOWUPS = 20;
export const OBJECTIVE_MAX_FOLLOWUPS = 100;
export const OBJECTIVE_MAX_CHARS = 4000;

const HUMAN_ACTIONS: readonly ObjectiveAction[] = ["start", "pause", "resume", "stop", "update", "block", "complete"];
export const AGENT_ACTIONS = ["update", "pause", "resume", "block", "complete", "cancel"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/** Advisory-lock slot for the followup sweep (mirrors the stall sweep pattern). */
const OBJECTIVE_SWEEP_LOCK = 1937006963;

export interface ParsedObjectiveCommand {
    action: ObjectiveAction | "status" | "unsupported";
    objective: string;
    cadenceMinutes?: number;
}

/**
 * Parse `/goal` and `/objective` slash commands. `/goal` stays supported as the
 * command name for backwards compatibility, but now starts an Emperor-owned
 * objective instead of a runtime-native goal. `clear`/`cancel` mean stop.
 */
export function parseObjectiveCommand(text: string): ParsedObjectiveCommand | null {
    const match = text.trim().match(/^\/(?:goal|objective)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    const value = (match[1] || "").trim();
    if (/^--\s+/.test(value)) return { action: "start", objective: value.replace(/^--\s+/, "") };
    if (/^(draft|gate|wait|unwait|subgoal)(?:\s|$)/i.test(value)) return { action: "unsupported", objective: "" };
    if (!value || /^(status|show)(?:\s|$)/i.test(value)) return { action: "status", objective: "" };
    if (/^(pause|resume|clear|stop|cancel|block|complete|done)(?:\s|$)/i.test(value)) {
        const word = value.split(/\s/)[0].toLowerCase();
        const action = word === "clear" || word === "cancel" ? "stop"
            : word === "done" ? "complete"
                : (word as ObjectiveAction);
        return { action, objective: value.slice(word.length).trim() };
    }
    return { action: "start", objective: value.replace(/^--\s+/, "") };
}

export function clampCadenceMinutes(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return OBJECTIVE_DEFAULT_CADENCE_MINUTES;
    return Math.min(OBJECTIVE_MAX_CADENCE_MINUTES, Math.max(OBJECTIVE_MIN_CADENCE_MINUTES, Math.round(n)));
}

export function clampMaxFollowups(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return OBJECTIVE_DEFAULT_MAX_FOLLOWUPS;
    return Math.min(OBJECTIVE_MAX_FOLLOWUPS, Math.max(1, Math.round(n)));
}

type ObjectiveRow = typeof agentObjectives.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function publicObjective(objective: ObjectiveRow) {
    return {
        id: objective.id,
        objective: objective.objective,
        status: objective.status as ObjectiveStatus,
        cadenceMinutes: objective.cadenceMinutes,
        maxFollowups: objective.maxFollowups,
        followupCount: objective.followupCount,
        blockerReason: objective.blockerReason ?? null,
        completionSummary: objective.completionSummary ?? null,
        lastPromptAt: objective.lastPromptAt,
        nextRunAt: objective.nextRunAt,
        startedAt: objective.startedAt,
        completedAt: objective.completedAt,
        updatedAt: objective.updatedAt,
        restricted: false as const,
    };
}

export type PublicObjective = ReturnType<typeof publicObjective>;

/** The shape a member who is neither owner nor admin sees: no private text. */
export function redactedObjective(objective: ObjectiveRow) {
    return {
        id: objective.id,
        objective: null,
        status: objective.status as ObjectiveStatus,
        cadenceMinutes: objective.cadenceMinutes,
        maxFollowups: objective.maxFollowups,
        followupCount: objective.followupCount,
        blockerReason: null,
        completionSummary: null,
        lastPromptAt: null,
        nextRunAt: null,
        startedAt: objective.startedAt,
        completedAt: objective.completedAt,
        updatedAt: objective.updatedAt,
        restricted: true as const,
        message: "Managed in another private conversation.",
    };
}

async function requireAgent(companyId: string, agentId: string) {
    const [agent] = await db.select({ id: agents.id, name: agents.name, provider: agents.provider })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId), isNull(agents.deletedAt)))
        .limit(1);
    if (!agent) throw new Error("Agent not found");
    return agent;
}

async function latestObjective(companyId: string, agentId: string): Promise<ObjectiveRow | null> {
    const [objective] = await db.select().from(agentObjectives).where(and(
        eq(agentObjectives.companyId, companyId),
        eq(agentObjectives.agentId, agentId),
        isNull(agentObjectives.deletedAt),
    )).orderBy(desc(agentObjectives.createdAt), desc(agentObjectives.id)).limit(1);
    return objective ?? null;
}

async function latestObjectiveTx(tx: Tx, companyId: string, agentId: string): Promise<ObjectiveRow | null> {
    const [objective] = await tx.select().from(agentObjectives).where(and(
        eq(agentObjectives.companyId, companyId),
        eq(agentObjectives.agentId, agentId),
        isNull(agentObjectives.deletedAt),
    )).orderBy(desc(agentObjectives.createdAt), desc(agentObjectives.id)).limit(1);
    return objective ?? null;
}

/** Serialize every mutation for an agent on the same row lock. */
async function lockAgentRow(tx: Tx, companyId: string, agentId: string) {
    const [row] = await tx.select({ id: agents.id }).from(agents).where(and(
        eq(agents.companyId, companyId),
        eq(agents.id, agentId),
        isNull(agents.deletedAt),
    )).limit(1).for("no key update");
    if (!row) throw new Error("Agent not found");
}

/**
 * A member may read/manage an objective only when they created it, or they are
 * a company owner/admin. This mirrors the privacy the native goal UI had.
 */
async function assertCanManageHuman(companyId: string, userId: string, objective: ObjectiveRow) {
    if (!objective.createdByUserId || objective.createdByUserId === userId) return;
    if (await isCompanyOwnerOrAdmin(companyId, userId)) return;
    throw new Error("Access denied: this objective belongs to another person's private conversation");
}

/** Cancel queued objective prompts so a stopped/held objective cannot wake later. */
async function cancelQueuedPromptsTx(tx: Tx, companyId: string, objectiveId: string) {
    await tx.update(threadMessages).set({ deliveryState: "cancelled" }).where(and(
        eq(threadMessages.companyId, companyId),
        sql`${threadMessages.metadataJson}->>'objectiveId' = ${objectiveId}`,
        eq(threadMessages.deliveryState, "queued"),
    ));
}

export async function readAgentObjective(companyId: string, agentId: string, viewerId?: string | null) {
    await requireAgent(companyId, agentId);
    const objective = await latestObjective(companyId, agentId);
    if (!objective) return { supported: true as const, restricted: false as const, objective: null };
    const mustRedact = Boolean(
        viewerId && objective.createdByUserId && objective.createdByUserId !== viewerId &&
        !(await isCompanyOwnerOrAdmin(companyId, viewerId)),
    );
    return {
        supported: true as const,
        restricted: mustRedact,
        objective: mustRedact ? redactedObjective(objective) : publicObjective(objective),
    };
}

export async function listAgentObjectives(companyId: string, agentId: string) {
    await requireAgent(companyId, agentId);
    const rows = await db.select().from(agentObjectives).where(and(
        eq(agentObjectives.companyId, companyId),
        eq(agentObjectives.agentId, agentId),
        isNull(agentObjectives.deletedAt),
    )).orderBy(desc(agentObjectives.createdAt));
    return rows.map(publicObjective);
}

/** The compact instructions the agent receives on every followup. */
export function objectiveFollowupText(objective: Pick<ObjectiveRow, "id" | "objective" | "cadenceMinutes" | "followupCount" | "maxFollowups">): string {
    const used = objective.followupCount + 1;
    return [
        `Automatic objective check-in. Objective: ${objective.objective}`,
        "",
        `Cadence: every ${objective.cadenceMinutes} min · followup ${used}/${objective.maxFollowups}.`,
        "Do the actual work now with your normal tools, then report back.",
        `- If you have the objective tool: call update_objective with { objectiveId: "${objective.id}", action: "update"|"block"|"complete"|"pause"|"resume"|"cancel", ... } (block needs blockerReason; complete takes completionSummary).`,
        "- If you cannot use tools, end your reply with ONE line by itself and nothing after it:",
        `  EMPEROR_OBJECTIVE_STATUS {"objectiveId":"${objective.id}","action":"update|block|complete","summary":"...","blockerReason":"...","completionSummary":"..."}`,
        "",
        "Keep your chat reply short: what changed, what is next, or what is blocking you. Do not repeat the marker line in your visible text.",
    ].join("\n");
}

function cadenceMs(minutes: number): number {
    return minutes * 60_000;
}

/** Resolve the thread a followup must land in: the objective's originating one. */
async function resolveObjectiveThreadId(companyId: string, objective: ObjectiveRow): Promise<string> {
    if (objective.threadId) {
        const [thread] = await db.select({ id: messageThreads.id }).from(messageThreads).where(and(
            eq(messageThreads.id, objective.threadId),
            eq(messageThreads.companyId, companyId),
        )).limit(1);
        if (thread) return thread.id;
    }
    const thread = await ensureDirectThread(companyId, objective.agentId, objective.createdByUserId ?? null);
    return thread.id;
}

/** Insert a queued objective prompt with an executor (db or tx). */
async function insertObjectivePrompt(tx: Tx, objective: ObjectiveRow, threadId: string, kind: "followup" | "start") {
    const [message] = await tx.insert(threadMessages).values({
        companyId: objective.companyId,
        threadId,
        senderType: "system",
        targetAgentId: objective.agentId,
        text: objectiveFollowupText(objective),
        // Queued, so every runtime picks it up as a normal private prompt.
        deliveryState: "queued",
        metadataJson: {
            objectiveId: objective.id,
            objectiveFollowup: true,
            objectiveKind: kind,
            companyId: objective.companyId,
        },
    }).returning();
    return { threadId, message };
}

async function broadcastPrompt(companyId: string, threadId: string, message: unknown) {
    broadcastMcpEvent(companyId, { type: "thread_message", threadId, message });
}

/** Human start/control from the web UI or `/goal`. All mutations are serialized. */
export async function requestAgentObjective(companyId: string, userId: string, agentId: string, input: {
    action: ObjectiveAction;
    objective?: string;
    cadenceMinutes?: number;
    maxFollowups?: number;
    blockerReason?: string | null;
}) {
    await requireAgent(companyId, agentId);
    const action = input.action;
    if (!HUMAN_ACTIONS.includes(action)) throw new Error("Invalid objective action");

    if (action === "start") {
        const objectiveText = typeof input.objective === "string" ? input.objective.trim() : "";
        if (!objectiveText) throw new Error("An objective must contain 1–4,000 characters");
        if (objectiveText.length > OBJECTIVE_MAX_CHARS) throw new Error(`An objective must be at most ${OBJECTIVE_MAX_CHARS} characters`);
        const cadenceMinutes = clampCadenceMinutes(input.cadenceMinutes);
        const maxFollowups = clampMaxFollowups(input.maxFollowups);
        // Start in the human's private conversation with the agent.
        const thread = await ensureDirectThread(companyId, agentId, userId);

        const created = await db.transaction(async (tx) => {
            await lockAgentRow(tx, companyId, agentId);
            const existing = await latestObjectiveTx(tx, companyId, agentId);
            if (existing) {
                await assertCanManageHuman(companyId, userId, existing);
                if (existing.status === "active" || existing.status === "blocked") {
                    throw new Error("An objective is already running. Pause, complete or stop it before starting a new one.");
                }
                // Retire the paused/closed objective and cancel anything queued.
                await cancelQueuedPromptsTx(tx, companyId, existing.id);
                await tx.update(agentObjectives).set({ status: "cancelled", nextRunAt: null, completedAt: new Date(), updatedAt: new Date() })
                    .where(eq(agentObjectives.id, existing.id));
            }
            const now = new Date();
            const [row] = await tx.insert(agentObjectives).values({
                companyId,
                agentId,
                createdByUserId: userId,
                threadId: thread.id,
                objective: objectiveText,
                cadenceMinutes,
                maxFollowups,
                followupCount: 1,
                status: "active",
                lastPromptAt: now,
                nextRunAt: new Date(now.getTime() + cadenceMs(cadenceMinutes)),
            }).returning();
            await insertObjectivePrompt(tx, row, thread.id, "start");
            return row;
        });
        broadcastMcpEvent(companyId, { type: "objective_updated", objective: created });
        return { objective: publicObjective(created), pending: true };
    }

    // Control/edit an existing objective.
    const result = await db.transaction(async (tx) => {
        await lockAgentRow(tx, companyId, agentId);
        const existing = await latestObjectiveTx(tx, companyId, agentId);
        if (!existing) throw new Error("No objective has been started yet");
        await assertCanManageHuman(companyId, userId, existing);
        return applyObjectiveAction(tx, existing, action, {
            objective: input.objective,
            cadenceMinutes: input.cadenceMinutes,
            blockerReason: input.blockerReason,
            actor: "human",
        });
    });
    broadcastMcpEvent(companyId, { type: "objective_updated", objective: result });
    return { objective: result };
}

interface ActionInput {
    summary?: string | null;
    blockerReason?: string | null;
    completionSummary?: string | null;
    objective?: string | null;
    cadenceMinutes?: number | null;
    actor: "human" | "agent";
}

/** Apply one action to a locked objective row. Shared by the human and agent paths. */
async function applyObjectiveAction(tx: Tx, objective: ObjectiveRow, action: ObjectiveAction | AgentAction, input: ActionInput): Promise<PublicObjective> {
    const now = new Date();
    const patch: Partial<ObjectiveRow> = { updatedAt: now, lastReportedAt: now };
    let cancelQueued = false;

    switch (action) {
        case "update": {
            if (typeof input.objective === "string" && input.objective.trim()) {
                if (input.objective.length > OBJECTIVE_MAX_CHARS) throw new Error(`Objective must be at most ${OBJECTIVE_MAX_CHARS} characters`);
                patch.objective = input.objective.trim();
            }
            if (input.cadenceMinutes != null) patch.cadenceMinutes = clampCadenceMinutes(input.cadenceMinutes);
            if (typeof input.summary === "string" && input.summary.trim() && objective.status === "blocked") {
                // A progress report lifts a stale blocker and resumes the clock.
                patch.status = "active";
                patch.blockerReason = null;
                patch.nextRunAt = new Date(now.getTime() + cadenceMs(patch.cadenceMinutes ?? objective.cadenceMinutes));
            }
            break;
        }
        case "pause": {
            if (objective.status === "completed" || objective.status === "cancelled") throw new Error("This objective is already closed");
            patch.status = "paused";
            patch.nextRunAt = null;
            cancelQueued = true;
            break;
        }
        case "resume": {
            if (objective.status === "completed" || objective.status === "cancelled") throw new Error("This objective is already closed");
            if (objective.followupCount >= objective.maxFollowups) throw new Error("This objective reached its followup budget; start a new one");
            patch.status = "active";
            patch.blockerReason = null;
            patch.nextRunAt = new Date(now.getTime() + cadenceMs(objective.cadenceMinutes));
            break;
        }
        case "block": {
            const reason = typeof input.blockerReason === "string" ? input.blockerReason.trim() : "";
            if (!reason) throw new Error("A blocker reason is required");
            patch.status = "blocked";
            patch.blockerReason = reason.slice(0, 1000);
            patch.nextRunAt = null;
            cancelQueued = true;
            break;
        }
        case "complete": {
            patch.status = "completed";
            patch.completionSummary = (typeof input.completionSummary === "string" && input.completionSummary.trim())
                ? input.completionSummary.trim().slice(0, 2000)
                : null;
            patch.blockerReason = null;
            patch.nextRunAt = null;
            patch.completedAt = now;
            cancelQueued = true;
            break;
        }
        case "cancel": {
            patch.status = "cancelled";
            patch.nextRunAt = null;
            patch.completedAt = now;
            cancelQueued = true;
            break;
        }
        default:
            throw new Error("Invalid objective action");
    }

    if (cancelQueued) await cancelQueuedPromptsTx(tx, objective.companyId, objective.id);
    const [updated] = await tx.update(agentObjectives).set(patch).where(and(
        eq(agentObjectives.companyId, objective.companyId),
        eq(agentObjectives.id, objective.id),
    )).returning();
    return publicObjective(updated);
}

/**
 * Update an objective from the authenticated owning agent (MCP tool / route).
 * Ownership is enforced by the (company, agent) pair, so one agent can never
 * pause, complete or cancel another agent's objective.
 */
export async function updateObjectiveFromAgent(companyId: string, actorAgentId: string, input: {
    objectiveId: string;
    action: AgentAction;
    summary?: string | null;
    blockerReason?: string | null;
    completionSummary?: string | null;
    objective?: string | null;
    cadenceMinutes?: number | null;
}) {
    if (!AGENT_ACTIONS.includes(input.action)) throw new Error("Invalid objective action");
    return db.transaction(async (tx) => {
        await lockAgentRow(tx, companyId, actorAgentId);
        const [objective] = await tx.select().from(agentObjectives).where(and(
            eq(agentObjectives.companyId, companyId),
            eq(agentObjectives.id, input.objectiveId),
            isNull(agentObjectives.deletedAt),
        )).limit(1);
        if (!objective) throw new Error("Objective not found");
        // Company + agent ownership: an agent may only touch its own objective.
        if (objective.agentId !== actorAgentId) throw new Error("Access denied: you can only update your own objective");
        const updated = await applyObjectiveAction(tx, objective, input.action, {
            summary: input.summary,
            blockerReason: input.blockerReason,
            completionSummary: input.completionSummary,
            objective: input.objective,
            cadenceMinutes: input.cadenceMinutes,
            actor: "agent",
        });
        broadcastMcpEvent(companyId, { type: "objective_updated", objective: updated });
        return updated;
    });
}

/** The status line `/goal status` posts back into the direct conversation. */
export function objectiveStatusText(objective: PublicObjective | ReturnType<typeof redactedObjective> | null): string {
    if (!objective) return "No objective has been started. Start one with /goal <objective>.";
    if (objective.restricted) return `Objective: ${objective.message}`;
    const lines = [
        `Objective: ${objective.objective}`,
        `Status: ${objective.status}`,
        `Cadence: every ${objective.cadenceMinutes} min · followups ${objective.followupCount}/${objective.maxFollowups}`,
    ];
    if (objective.blockerReason) lines.push(`Blocker: ${objective.blockerReason}`);
    if (objective.completionSummary) lines.push(`Result: ${objective.completionSummary}`);
    return lines.join("\n");
}

export async function replyObjectiveStatus(companyId: string, userId: string, agentId: string) {
    const read = await readAgentObjective(companyId, agentId, userId);
    const thread = await ensureDirectThread(companyId, agentId, userId);
    const message = await threadMessageInsert(companyId, thread.id, agentId, userId, objectiveStatusText(read.objective));
    broadcastMcpEvent(companyId, { type: "thread_message", threadId: thread.id, message });
    return { thread, message };
}

// A tiny wrapper so the status reply shares append semantics without importing
// the heavier control-plane append path (which is not needed for a system line).
async function threadMessageInsert(companyId: string, threadId: string, agentId: string, userId: string, text: string) {
    const [message] = await db.insert(threadMessages).values({
        companyId,
        threadId,
        targetAgentId: agentId,
        senderId: userId,
        senderType: "system",
        deliveryState: "resolved",
        text,
        metadataJson: { objectiveStatus: true },
    }).returning();
    return message;
}

/**
 * The followup sweep. Runs from the lifecycle monitor. A transaction-scoped
 * advisory lock makes concurrent servers skip instead of double-posting; each
 * objective is then processed under its agent row lock, so a pause/stop racing
 * the tick can never post after the decision. The budget caps a runaway
 * objective and the overlap check stops a second prompt while the agent is
 * still working on the previous one.
 */
export async function runObjectiveFollowups(now = new Date()): Promise<number> {
    return db.transaction(async (tx) => {
        const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${OBJECTIVE_SWEEP_LOCK}, 1) AS locked`);
        if (!lock.rows[0]?.locked) return 0;
        return runLockedObjectiveFollowups(now);
    });
}

async function runLockedObjectiveFollowups(now: Date): Promise<number> {
    const due = await db.select().from(agentObjectives).where(and(
        eq(agentObjectives.status, "active"),
        isNotNull(agentObjectives.nextRunAt),
        lte(agentObjectives.nextRunAt, now),
        isNull(agentObjectives.deletedAt),
    )).orderBy(agentObjectives.nextRunAt).limit(50);

    let posted = 0;
    for (const candidate of due) {
        posted += await processObjectiveTick(candidate, now);
    }
    return posted;
}

async function processObjectiveTick(candidate: ObjectiveRow, now: Date): Promise<number> {
    return db.transaction(async (tx) => {
        // Serialize with human start/control and with the agent's own updates.
        await lockAgentRow(tx, candidate.companyId, candidate.agentId);
        const [objective] = await tx.select().from(agentObjectives).where(and(
            eq(agentObjectives.id, candidate.id),
            eq(agentObjectives.companyId, candidate.companyId),
            isNull(agentObjectives.deletedAt),
        )).limit(1);
        // Re-check under the lock: a pause/stop that won the race must win.
        if (!objective || objective.status !== "active") return 0;
        if (objective.nextRunAt && objective.nextRunAt.getTime() > now.getTime()) return 0;

        if (objective.followupCount >= objective.maxFollowups) {
            await tx.update(agentObjectives).set({
                status: "paused",
                nextRunAt: null,
                blockerReason: objective.blockerReason ?? "Followup budget reached.",
                updatedAt: now,
            }).where(eq(agentObjectives.id, objective.id));
            return 0;
        }

        // Never overlap: if a followup for this objective is still queued,
        // seen, or acting, push the next run out instead of stacking prompts.
        const [inFlight] = await tx.select({ id: threadMessages.id }).from(threadMessages).where(and(
            eq(threadMessages.companyId, objective.companyId),
            sql`${threadMessages.metadataJson}->>'objectiveId' = ${objective.id}`,
            inArray(threadMessages.deliveryState, ["queued", "seen", "acting"]),
        )).limit(1);
        if (inFlight) {
            await tx.update(agentObjectives).set({
                nextRunAt: new Date(now.getTime() + cadenceMs(objective.cadenceMinutes)),
                updatedAt: now,
            }).where(eq(agentObjectives.id, objective.id));
            return 0;
        }

        const threadId = await resolveObjectiveThreadId(objective.companyId, objective);
        const { message } = await insertObjectivePrompt(tx, objective, threadId, "followup");
        await tx.update(agentObjectives).set({
            followupCount: objective.followupCount + 1,
            lastPromptAt: now,
            nextRunAt: new Date(now.getTime() + cadenceMs(objective.cadenceMinutes)),
            updatedAt: now,
        }).where(eq(agentObjectives.id, objective.id));
        await broadcastPrompt(objective.companyId, threadId, message);
        return 1;
    });
}
