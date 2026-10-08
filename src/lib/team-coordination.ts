/** Coordination is scoped to a membership, never a company-wide rank or permission. */
export type CoordinatorRef = { kind: "agent" | "human"; id: string };
export function isCoordinatorRole(role: string): boolean {
    return role === "coordinator" || role === "owner_coordinator";
}
export function coordinationRole(role: string, selected: boolean): string {
    const owner = role === "owner" || role === "owner_coordinator";
    return selected ? (owner ? "owner_coordinator" : "coordinator") : (owner ? "owner" : "member");
}
export function teamCoordinator<T extends CoordinatorRef & { role: string }>(members: readonly T[]): T | null {
    return members.find((member) => isCoordinatorRole(member.role)) ?? null;
}
