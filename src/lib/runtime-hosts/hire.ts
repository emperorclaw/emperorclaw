// Hiring an agent onto a runtime host (0.22). Pure: whether a host can take
// a new agent, on which gateway topology, and what it needs. Shared by the
// API (POST /api/agents) and the host list the hire dialog shows.

import { HOST_LLM_PROVIDERS, PROVISION_MEMORY_MIB, hostSupports, type HostLlmProvider } from "./commands";

export type HireHostFacts = {
    status: string;
    revoked: boolean;
    commands: readonly string[];
    llmProviders: readonly string[];
    memAvailMiB: number | null;
    /** Memory already promised to setups queued or running on this host. */
    reservedMiB?: number;
    browser: boolean;
    profiles: readonly { topology?: string | null; legacy?: boolean | null }[];
};

export type HireReadiness = {
    ok: boolean;
    /** Why not, in words for the hire dialog (null when ok). */
    reason: string | null;
    /** "update": the host must be updated first (its daemon predates 0.22). */
    code: "ok" | "revoked" | "offline" | "update" | "no_provider" | "memory";
    gateway: "standalone" | "shared";
    needMiB: number;
    skipBrowser: boolean;
    /** Providers a new agent can use here (a key is on the host and the daemon can configure it). */
    providers: HostLlmProvider[];
};

/**
 * The gateway topology a new agent gets: shared when the host's managed
 * agents all share one gateway (a Raspberry Pi), standalone otherwise.
 */
export function gatewayForNewAgent(profiles: HireHostFacts["profiles"]): "standalone" | "shared" {
    const managed = profiles.filter((p) => !p.legacy && (p.topology === "shared" || p.topology === "standalone"));
    return managed.length > 0 && managed.every((p) => p.topology === "shared") ? "shared" : "standalone";
}

export function hireReadiness(host: HireHostFacts): HireReadiness {
    const gateway = gatewayForNewAgent(host.profiles);
    const needMiB = PROVISION_MEMORY_MIB[gateway];
    const providers = HOST_LLM_PROVIDERS.filter((p) => host.llmProviders.includes(p));
    const base = { gateway, needMiB, skipBrowser: !host.browser, providers };
    if (host.revoked) return { ...base, ok: false, code: "revoked", reason: "This host was revoked" };
    if (host.status !== "online") return { ...base, ok: false, code: "offline", reason: "Offline" };
    if (!hostSupports(host.commands, "provision_agent")) return { ...base, ok: false, code: "update", reason: "Update this host to hire here" };
    if (providers.length === 0) {
        return { ...base, ok: false, code: "no_provider", reason: "No model provider key on this host (add one to ~/.hermes/.env)" };
    }
    const reserved = host.reservedMiB ?? 0;
    if (host.memAvailMiB != null && host.memAvailMiB - reserved < needMiB) {
        const left = Math.max(0, host.memAvailMiB - reserved);
        return {
            ...base, ok: false, code: "memory",
            reason: reserved > 0
                ? `Not enough free memory (${left} MB left after the ${reserved} MB the setups already queued need; a new agent needs ${needMiB} MB)`
                : `Not enough free memory (${host.memAvailMiB} MB free, a new agent needs ${needMiB} MB)`,
        };
    }
    return { ...base, ok: true, code: "ok", reason: null };
}
