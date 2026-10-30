// Hiring an agent onto a runtime host (0.22). Pure: whether a host can take
// a new agent, on which gateway topology, and what it needs. Shared by the
// API (POST /api/agents) and the host list the hire dialog shows.

import { HOST_LLM_PROVIDERS, PROVISION_MEMORY_MIB, hostSupports, type HostLlmProvider } from "./commands";
import { copy, type CodedCopy } from "@/lib/coded-copy";

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
    /** The numbers in a "memory" reason, so the UI can word it in the viewer's language (free, or left after reserved). */
    reasonValues?: { needMiB: number; freeMiB?: number; leftMiB?: number; reservedMiB?: number };
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
            reasonValues: reserved > 0 ? { needMiB, leftMiB: left, reservedMiB: reserved } : { needMiB, freeMiB: host.memAvailMiB },
            reason: reserved > 0
                ? `Not enough free memory (${left} MB left after the ${reserved} MB the setups already queued need; a new agent needs ${needMiB} MB)`
                : `Not enough free memory (${host.memAvailMiB} MB free, a new agent needs ${needMiB} MB)`,
        };
    }
    return { ...base, ok: true, code: "ok", reason: null };
}

/**
 * Why a host cannot take a new agent, as coded copy (runtimeHosts.hireReasons.*)
 * for the hire dialog in the viewer's language; null when it can (or the reason
 * is one this build has no message for: the English reason shows instead).
 */
export function hireReasonCopy(hire: Pick<HireReadiness, "code" | "reason" | "reasonValues">): CodedCopy | null {
    if (!hire.reason) return null;
    switch (hire.code) {
        case "revoked":
        case "offline":
        case "update":
        case "no_provider":
            return copy(`runtimeHosts.hireReasons.${hire.code}`);
        case "memory": {
            const values = hire.reasonValues;
            if (!values) return null;
            return values.reservedMiB
                ? copy("runtimeHosts.hireReasons.memoryReserved", { left: values.leftMiB ?? 0, reserved: values.reservedMiB, need: values.needMiB })
                : copy("runtimeHosts.hireReasons.memory", { free: values.freeMiB ?? 0, need: values.needMiB });
        }
        default:
            return null;
    }
}
