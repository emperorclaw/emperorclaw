import type { SessionWithUserId } from "@/lib/auth";

export type MemberScope = {
    agentIds?: string[];
    customerIds?: string[];
    mode?: "all" | "restricted";
};

/**
 * Get scope from session (already loaded during auth).
 * No DB query needed — scope is in the JWT.
 */
export function getScopeFromSession(session: SessionWithUserId): MemberScope | null {
    const scope = (session.user as any)?.scopeJson as MemberScope | undefined;
    if (!scope || scope.mode !== "restricted") return null;
    return scope;
}

/**
 * Apply scope filter to a list of items in-memory.
 */
export function filterByScope<T extends { id: string }>(
    items: T[],
    allowedIds: string[] | undefined,
): T[] {
    if (!allowedIds || allowedIds.length === 0) return items;
    const set = new Set(allowedIds);
    return items.filter(item => set.has(item.id));
}

/**
 * Get scoped agent IDs for filtering queries.
 */
export function getScopedAgentIds(scope: MemberScope | null): string[] | undefined {
    if (!scope) return undefined;
    return scope.agentIds?.length ? scope.agentIds : undefined;
}

/**
 * Get scoped customer IDs for filtering queries.
 */
export function getScopedCustomerIds(scope: MemberScope | null): string[] | undefined {
    if (!scope) return undefined;
    return scope.customerIds?.length ? scope.customerIds : undefined;
}

