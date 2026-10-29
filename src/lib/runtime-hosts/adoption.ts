// Adoption (0.21): which agents a host's inventory claims. Pure: the store
// loads the agents and applies the plan.
//
// A profile is adopted only when it names an agent of the host's own company
// (not deleted), its .env points at this Emperor, it is not a bridge 0.3
// (legacy) profile, and the agent is not already on another live host.
// Anything else is a conflict and takes nothing. Agents this host held that
// its inventory no longer lists are released.

import type { InventoryProfile } from "./protocol";

export type AdoptionAgent = {
    id: string;
    companyId: string;
    deleted: boolean;
    runtimeHostId: string | null;
    runtimeProfile: string | null;
    /** The host it is on was revoked: the agent is free to be adopted. */
    runtimeHostRevoked?: boolean;
};

export type AdoptionConflictReason = "unknown_agent" | "other_emperor" | "other_host" | "duplicate_profile";

export type AdoptionPlan = {
    /** Agents to set runtime_host_id/runtime_profile on (only when something changes). */
    adopt: { agentId: string; profile: string }[];
    /** Agents on this host whose profile is gone from the inventory. */
    release: string[];
    /** Profiles that name an agent but take nothing, and why. */
    conflicts: { profile: string; agentId: string; reason: AdoptionConflictReason }[];
    /** Every agent this host serves after the plan (adopted or unchanged). */
    served: { agentId: string; profile: string }[];
};

export function planAdoption(input: {
    hostId: string;
    companyId: string;
    profiles: readonly Pick<InventoryProfile, "profile" | "agentId" | "sameEmperor" | "legacy">[];
    /** The agents the profiles name (any company), by id. */
    agentsById: ReadonlyMap<string, AdoptionAgent>;
    /** Agents currently on this host (runtime_host_id = hostId). */
    currentlyOnHost: readonly { id: string }[];
}): AdoptionPlan {
    const adopt: AdoptionPlan["adopt"] = [];
    const conflicts: AdoptionPlan["conflicts"] = [];
    const served: AdoptionPlan["served"] = [];
    const claimed = new Set<string>();

    for (const p of input.profiles) {
        const agentId = p.agentId?.toLowerCase();
        if (!agentId || p.legacy) continue;
        if (!p.sameEmperor) {
            conflicts.push({ profile: p.profile, agentId, reason: "other_emperor" });
            continue;
        }
        const agent = input.agentsById.get(agentId);
        // Another company's agent looks exactly like an unknown one: nothing leaks.
        if (!agent || agent.deleted || agent.companyId !== input.companyId) {
            conflicts.push({ profile: p.profile, agentId, reason: "unknown_agent" });
            continue;
        }
        if (claimed.has(agentId)) {
            conflicts.push({ profile: p.profile, agentId, reason: "duplicate_profile" });
            continue;
        }
        const elsewhere = agent.runtimeHostId && agent.runtimeHostId !== input.hostId && !agent.runtimeHostRevoked;
        if (elsewhere) {
            conflicts.push({ profile: p.profile, agentId, reason: "other_host" });
            continue;
        }
        claimed.add(agentId);
        served.push({ agentId, profile: p.profile });
        if (agent.runtimeHostId !== input.hostId || agent.runtimeProfile !== p.profile) {
            adopt.push({ agentId, profile: p.profile });
        }
    }
    const release = input.currentlyOnHost.map((a) => a.id).filter((id) => !claimed.has(id));
    return { adopt, release, conflicts, served };
}
