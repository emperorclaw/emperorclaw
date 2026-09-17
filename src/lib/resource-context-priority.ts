/** Auto-injection is opt-in; explicit selections can load reference notes. */
export function resourceContextPriority(resource: {
    id: string;
    name: string;
    displayName?: string | null;
    scopeType: string;
    scopeId?: string | null;
    isShared: boolean;
}, context: {
    customerId?: string | null;
    projectId?: string | null;
    agentId?: string | null;
    selected: Set<string>;
    matchingTags: Set<string>;
    neighbors: Set<string>;
}) {
    const matchesScope = resource.scopeType === "company" ||
        (resource.scopeType === "customer" && resource.scopeId === context.customerId) ||
        (resource.scopeType === "project" && resource.scopeId === context.projectId) ||
        (resource.scopeType === "agent" && resource.scopeId === context.agentId);
    if (resource.isShared && matchesScope) {
        return resource.scopeType === "company" && /operating|doctrine/i.test(`${resource.name} ${resource.displayName || ""}`) ? 1 : 2;
    }
    if (context.selected.has(resource.id) || context.matchingTags.has(resource.id)) return 3;
    if (context.neighbors.has(resource.id)) return 4;
    return 99;
}
