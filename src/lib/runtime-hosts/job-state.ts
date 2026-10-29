// The runtime host job state machine (0.21). Pure: the store applies it with
// conditional UPDATEs so concurrent instances never move a job twice.
//
//   queued --dispatch--> sent --ack(accepted)--> running --result--> succeeded | failed
//     ^                   |  \--ack(busy) / no ack in 30 s (attempts < 3)--> queued
//     |                   \--ack(refused) / no ack after 3 attempts--> failed
//   queued --cancel/expire--> canceled          (a queued remove_agent never expires)
//   running --past deadline + 60 s--> timed_out
//   sent | running --host gone 15 min / unknown to the host after reconnect--> lost
//                                               (a remove_agent goes back to the queue instead:
//                                                the daemon replays or runs it when the host returns)

export const JOB_STATUSES = ["queued", "sent", "running", "succeeded", "failed", "timed_out", "canceled", "lost"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "timed_out", "canceled", "lost"];
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["sent", "running"];

/** How often a job is sent before a missing/busy ack fails it. */
export const MAX_JOB_ATTEMPTS = 3;
/** A sent job without an ack in this time goes back to the queue. */
export const JOB_ACK_TIMEOUT_MS = 30_000;
/** Grace after the deadline before a running job times out. */
export const JOB_DEADLINE_GRACE_MS = 60_000;
/** A host silent this long is offline. */
export const HOST_OFFLINE_AFTER_MS = 90_000;
/** Jobs of a host offline this long are lost. */
export const JOB_LOST_AFTER_MS = 15 * 60_000;
/** A queued job nobody could run in this time is dropped (a restart hours later would surprise). */
export const JOB_QUEUE_EXPIRY_MS = 60 * 60_000;

/**
 * Removals wait for their host however long it is away (until it is revoked):
 * the agent is already deleted in Emperor and only the host still has its
 * profile. Every other queued job expires after JOB_QUEUE_EXPIRY_MS.
 */
export const WAIT_FOR_HOST_COMMANDS: readonly string[] = ["remove_agent"];

export function expiresInQueue(command: string): boolean {
    return !WAIT_FOR_HOST_COMMANDS.includes(command);
}

/** A sent/running job of a long-gone host: lost, or (removals) back to the queue. */
export function statusWhenHostLost(command: string): "lost" | "queued" {
    return WAIT_FOR_HOST_COMMANDS.includes(command) ? "queued" : "lost";
}

export type JobEvent =
    | { type: "dispatch" }
    | { type: "ack"; accepted: boolean; reason?: string | null; attempts: number }
    | { type: "result"; ok: boolean }
    | { type: "ack_timeout"; attempts: number }
    | { type: "deadline" }
    | { type: "host_lost" }
    | { type: "unknown_to_host"; attempts: number }
    | { type: "cancel" }
    | { type: "expire" };

export function isTerminalJobStatus(status: string): boolean {
    return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

/** The status after an event, or null when the event does not apply (ignored, never an error). */
export function nextJobStatus(current: JobStatus, event: JobEvent): JobStatus | null {
    if (isTerminalJobStatus(current)) return null;
    switch (event.type) {
        case "dispatch":
            return current === "queued" ? "sent" : null;
        case "ack":
            if (current !== "sent" && current !== "running") return null;
            if (event.accepted) return "running";
            if (current === "running") return null; // a late refusal never undoes a running job
            if (event.reason === "busy") return event.attempts < MAX_JOB_ATTEMPTS ? "queued" : "failed";
            return "failed";
        case "result":
            return current === "sent" || current === "running" ? (event.ok ? "succeeded" : "failed") : null;
        case "ack_timeout":
        case "unknown_to_host":
            if (current === "sent") return event.attempts < MAX_JOB_ATTEMPTS ? "queued" : "failed";
            if (current === "running" && event.type === "unknown_to_host") return "lost";
            return null;
        case "deadline":
            return current === "running" || current === "sent" ? "timed_out" : null;
        case "host_lost":
            return current === "running" || current === "sent" ? "lost" : null;
        case "cancel":
        case "expire":
            return current === "queued" ? "canceled" : null;
    }
}

/** The states an event may start from (the WHERE of the store's conditional UPDATE). */
export function jobEventSources(event: JobEvent): JobStatus[] {
    return JOB_STATUSES.filter((status) => nextJobStatus(status, event) !== null);
}
