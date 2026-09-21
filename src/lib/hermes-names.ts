/**
 * Pure naming helpers for a Hermes agent's sibling Docker resources.
 *
 * Kept in a dependency-free module so provisioning, deletion, and their tests
 * all derive the exact same container/volume names — a drift here would leak an
 * orphan volume on delete or fail to find the container to stop.
 */

/** Docker-safe agent name used in container/volume names and runtime env vars. */
export function hermesSafeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

/** Docker container name for an agent's Hermes sibling container. */
export function hermesContainerName(safeName: string, agentId: string): string {
    return `emperor-hermes-${safeName}-${agentId.slice(0, 8)}`;
}

/** Named volume persisting an agent's Hermes profile/session/bridge state. */
export function hermesVolumeName(safeName: string, agentId: string): string {
    return `emperor-hermes-${safeName}-${agentId.slice(0, 8)}-home`;
}
