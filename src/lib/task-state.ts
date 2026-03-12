export type TaskState = "queued" | "in_progress" | "review" | "done" | "failed";

export function normalizeTaskState(input: unknown): TaskState | null {
  if (typeof input !== "string") return null;
  const state = input.trim().toLowerCase();

  switch (state) {
    case "queued":
      return "queued";
    case "running":
    case "inprogress":
    case "in-progress":
    case "in_progress":
      return "in_progress";
    case "needs_review":
    case "needs-review":
    case "review":
      return "review";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

export function isTerminalTaskState(state: TaskState): boolean {
  return state === "done" || state === "failed";
}

