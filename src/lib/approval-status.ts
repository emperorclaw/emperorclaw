import { TASK_STATES } from "./task-state";

/**
 * Approval lifecycle vocabulary and pure decision helpers.
 *
 * Kept free of any database or React import so the same rules drive the
 * server (lib/approvals.ts), the agent-facing MCP API, the Approvals page and
 * the dashboard Action inbox, and so they can be unit-tested without a DB.
 */

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "dismissed", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** A human's decision on an approval. `expired` is set by the sweep, not by hand. */
export type ApprovalDecision = "approved" | "rejected" | "dismissed";

/**
 * Action types with an effect outside the company or that is hard to undo.
 * A pending approval of one of these that sits too long is expired: an agent
 * must never act on a stale external request just because a human clicked the
 * only button the UI offered. `task_done` is deliberately absent — closing a
 * task can wait.
 */
export const EXTERNAL_ACTION_TYPES = ["send_email", "publish", "spend", "delete"] as const;
export type ExternalActionType = (typeof EXTERNAL_ACTION_TYPES)[number];

/** A pending external action older than this expires without a decision (48h). */
export const EXTERNAL_APPROVAL_TTL_MS = 48 * 60 * 60 * 1000;

export const EXPIRED_RESOLUTION_NOTE = "Expired after 48h without a decision";

/**
 * May the requesting agent act? Only an explicit "approved" says yes. Every
 * other state — including "dismissed" and "expired" — means do NOT act.
 */
export function mayProceed(status: string | null | undefined): boolean {
    return status === "approved";
}

export function isExternalAction(actionType: string | null | undefined): boolean {
    return Boolean(actionType) && (EXTERNAL_ACTION_TYPES as readonly string[]).includes(actionType as string);
}

/** Is a pending approval a stale external action that the sweep should expire? */
export function isExpirableApproval(
    input: { status: string; actionType: string; requestedAtMs: number },
    nowMs: number,
): boolean {
    return input.status === "pending"
        && isExternalAction(input.actionType)
        && nowMs - input.requestedAtMs > EXTERNAL_APPROVAL_TTL_MS;
}

/** Is a pending approval old enough that approving it needs a second look? (Any action type.) */
export function isStaleApproval(requestedAtMs: number, nowMs: number): boolean {
    return nowMs - requestedAtMs > EXTERNAL_APPROVAL_TTL_MS;
}

/** Whole days a request has been waiting, at least 1 — for the confirmation copy. */
export function approvalAgeDays(requestedAtMs: number, nowMs: number): number {
    return Math.max(1, Math.floor((nowMs - requestedAtMs) / (24 * 60 * 60 * 1000)));
}

/**
 * The task state a resolution moves the linked tasks to, or null to leave them
 * untouched.
 *
 * - approved + task_done: close the task.
 * - approved (any other action): "go ahead" — the task goes back to in_progress.
 * - rejected: back to the agent to revise.
 * - dismissed / expired: LEAVE THE TASK AS IT IS. A dismissal means the action
 *   is obsolete, so there is nothing to rework and nothing to complete; the
 *   least-destructive path is no state change. (The task still sits where the
 *   approval request put it — `review` — and a human decides what to do with
 *   it, but the agent is explicitly told not to act.)
 */
export function resolutionTaskState(
    status: ApprovalDecision | "expired",
    actionType: string,
): typeof TASK_STATES.done | typeof TASK_STATES.inProgress | null {
    if (status === "dismissed" || status === "expired") return null;
    return status === "approved" && actionType === "task_done" ? TASK_STATES.done : TASK_STATES.inProgress;
}

/**
 * The message the requesting agent receives about a decision, and whether the
 * message is worth waking it for. Approved `task_done` is the only case with
 * nothing left to do (deliveryState "resolved"); everything else is queued so
 * the runtime acts on it. Dismissal and expiry both tell the agent, in plain
 * words, NOT to perform the action.
 */
export function approvalDecisionMessage(input: {
    status: ApprovalDecision | "expired";
    actionType: string;
    refs: string;
    note?: string | null;
}): { text: string; deliveryState: "queued" | "resolved" } {
    const note = input.note && input.note.trim() ? input.note.trim() : null;
    const quoted = note ? `: "${note}"` : ".";

    if (input.status === "approved") {
        const next = input.actionType === "task_done"
            ? "The task is closed. Nothing else to do unless the note asks for it."
            : "Go ahead with it now, then update the task (note what you did, attach the evidence) and close it when its acceptance criteria are met.";
        return {
            text: `Approval granted for ${input.refs}${quoted}\n\n${next}`,
            deliveryState: input.actionType === "task_done" ? "resolved" : "queued",
        };
    }

    if (input.status === "rejected") {
        return {
            text: `Approval rejected for ${input.refs}${quoted}\n\nRevise according to the note, update the task, and request approval again when it's ready.`,
            deliveryState: "queued",
        };
    }

    if (input.status === "dismissed") {
        return {
            text: `Approval dismissed for ${input.refs} — do NOT perform this action; it is obsolete.${note ? ` Note: "${note}"` : ""}`,
            deliveryState: "queued",
        };
    }

    return {
        text: `Approval expired for ${input.refs} — do NOT perform this action. Ask again if it is still needed.`,
        deliveryState: "queued",
    };
}
