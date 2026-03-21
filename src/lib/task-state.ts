export const TASK_STATES = {
  inbox: "inbox",
  inProgress: "in_progress",
  review: "review",
  done: "done",
  failed: "failed",
  deadLetter: "dead_letter",
} as const;

export type TaskState =
  | typeof TASK_STATES.inbox
  | typeof TASK_STATES.inProgress
  | typeof TASK_STATES.review
  | typeof TASK_STATES.done
  | typeof TASK_STATES.failed;

export type PersistedTaskState = TaskState | typeof TASK_STATES.deadLetter;

export const ACTIVE_TASK_STATES = [
  TASK_STATES.inProgress,
  TASK_STATES.review,
] as const satisfies readonly TaskState[];

export const SLA_TRACKED_TASK_STATES = [
  TASK_STATES.inbox,
  TASK_STATES.inProgress,
  TASK_STATES.review,
] as const satisfies readonly TaskState[];

export function normalizeTaskState(input: unknown): TaskState | null {
  if (typeof input !== "string") return null;
  const state = input.trim().toLowerCase();

  switch (state) {
    case "queued":
    case TASK_STATES.inbox:
      return TASK_STATES.inbox;
    case "running":
    case "inprogress":
    case "in-progress":
    case TASK_STATES.inProgress:
      return TASK_STATES.inProgress;
    case "needs_review":
    case "needs-review":
    case TASK_STATES.review:
      return TASK_STATES.review;
    case TASK_STATES.done:
      return TASK_STATES.done;
    case TASK_STATES.failed:
      return TASK_STATES.failed;
    default:
      return null;
  }
}

export function isTerminalTaskState(state: PersistedTaskState): boolean {
  return (
    state === TASK_STATES.done ||
    state === TASK_STATES.failed ||
    state === TASK_STATES.deadLetter
  );
}
