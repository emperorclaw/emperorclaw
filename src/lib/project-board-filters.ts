const ASSIGNEE_FILTERS = new Set(["all", "human", "agent", "unassigned"]);

export function normalizeAssigneeFilter(
  value: string | null | undefined,
  validAssignees: { agentIds: string[]; memberIds: string[] },
): string {
  if (!value || value === "All Agents") return "all";
  if (ASSIGNEE_FILTERS.has(value)) return value;

  const [type, id] = value.split(":", 2);
  if (type === "agent" && validAssignees.agentIds.includes(id)) return value;
  if (type === "human" && validAssignees.memberIds.includes(id)) return value;
  return "all";
}

export function migrateLegacyAgentFilter(
  value: string | null | undefined,
  agentIds: string[],
): string {
  if (!value || value === "All Agents") return "all";
  return agentIds.includes(value) ? `agent:${value}` : "all";
}
