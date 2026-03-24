export type NormalizedTaskSpec = {
  title: string | null;
  description: string | null;
  acceptanceCriteria: string[];
  definitionOfDone: string | null;
  deliverables: string[];
  blockedReason: string | null;
  goal: string | null;
  ownerRole: string | null;
  readiness: "ready" | "underspecified";
  missingFields: string[];
  inputJson: Record<string, unknown>;
};

function toTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  const single = toTrimmedString(value);
  return single ? [single] : [];
}

export function normalizeTaskSpec(input: {
  taskType?: unknown;
  title?: unknown;
  description?: unknown;
  acceptanceCriteria?: unknown;
  definitionOfDone?: unknown;
  deliverables?: unknown;
  blockedReason?: unknown;
  goal?: unknown;
  ownerRole?: unknown;
  inputJson?: Record<string, unknown> | null;
}) : NormalizedTaskSpec {
  const existing = input.inputJson && typeof input.inputJson === "object" ? input.inputJson : {};

  const title = toTrimmedString(input.title) || toTrimmedString(existing.title) || null;
  const description = toTrimmedString(input.description) || toTrimmedString(existing.description) || null;
  const acceptanceCriteria = toStringArray(input.acceptanceCriteria).length > 0
    ? toStringArray(input.acceptanceCriteria)
    : toStringArray(existing.acceptanceCriteria);
  const definitionOfDone = toTrimmedString(input.definitionOfDone) || toTrimmedString(existing.definitionOfDone) || null;
  const deliverables = toStringArray(input.deliverables).length > 0
    ? toStringArray(input.deliverables)
    : toStringArray(existing.deliverables);
  const blockedReason = toTrimmedString(input.blockedReason) || toTrimmedString(existing.blockedReason) || null;
  const goal = toTrimmedString(input.goal) || toTrimmedString(existing.goal) || description || title || null;
  const ownerRole = toTrimmedString(input.ownerRole) || toTrimmedString(existing.ownerRole) || null;

  const missingFields: string[] = [];
  if (!title) missingFields.push("title");
  if (!description) missingFields.push("description");
  if (!definitionOfDone && acceptanceCriteria.length === 0) missingFields.push("acceptanceCriteria_or_definitionOfDone");
  if (deliverables.length === 0) missingFields.push("deliverables");

  return {
    title,
    description,
    acceptanceCriteria,
    definitionOfDone,
    deliverables,
    blockedReason,
    goal,
    ownerRole,
    readiness: missingFields.length > 0 ? "underspecified" : "ready",
    missingFields,
    inputJson: {
      ...existing,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
      ...(definitionOfDone ? { definitionOfDone } : {}),
      ...(deliverables.length > 0 ? { deliverables } : {}),
      ...(blockedReason ? { blockedReason } : {}),
      ...(goal ? { goal } : {}),
      ...(ownerRole ? { ownerRole } : {}),
      readiness: missingFields.length > 0 ? "underspecified" : "ready",
      missingFields,
      taskType: toTrimmedString(input.taskType) || toTrimmedString(existing.taskType) || null,
    },
  };
}
