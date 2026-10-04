/**
 * Agent memory: short, durable notes an agent keeps about how to work here —
 * a person's preference, a correction, a lesson. Company facts belong in
 * Knowledge & Rules and progress in task notes. Bridges put the newest
 * memories in every turn; people can add and remove them in the app.
 */
export const MEMORY_KINDS = ["preference", "lesson", "fact", "context"] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
    preference: "Preference",
    lesson: "Lesson",
    fact: "Fact",
    context: "Context",
};

export const MAX_MEMORY_LENGTH = 1000;
