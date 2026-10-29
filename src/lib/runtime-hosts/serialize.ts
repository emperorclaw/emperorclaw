// Runtime hosts as the API returns them (0.21+): no token hash, inventory
// trimmed to what the Settings tab and the hire dialog show. Pure.

import { bridgeUpdateState, normalizeBridgeVersion, LATEST_HERMES_BRIDGE_VERSION } from "@/lib/hermes-bridge-version";
import { hostCommandsFrom } from "./commands";
import { hireReadiness, type HireHostFacts } from "./hire";
import type { HostListEntry, RuntimeHostRow } from "./store";

type Inventory = {
    receivedAt?: string;
    resources?: { cpus?: number | null; memTotalMiB?: number | null; memAvailMiB?: number | null; diskFreeMiB?: number | null; load1?: number | null };
    capabilities?: { browser?: boolean; linger?: boolean | null; systemdUser?: boolean };
    llmProviders?: string[];
    profiles?: { profile: string; agentId?: string | null; topology?: string; status?: string; gateway?: string; bridge?: string; bridgeVersion?: string | null; legacy?: boolean; sameEmperor?: boolean; health?: { registered?: boolean | null; lastError?: string | null } }[];
    conflicts?: { profile: string; agentId: string; reason: string }[];
    heartbeat?: { memAvailMiB?: number | null; load1?: number | null; at?: string } | null;
    commands?: string[] | null;
};

/** The facts the hire decision reads, from a host row (reservedMiB: memory promised to queued setups). */
export function hireFactsOf(host: RuntimeHostRow, reservedMiB = 0): HireHostFacts {
    const inventory = (host.inventoryJson ?? {}) as Inventory;
    return {
        status: host.revokedAt ? "revoked" : host.status, revoked: Boolean(host.revokedAt), commands: hostCommandsFrom(inventory.commands),
        llmProviders: inventory.llmProviders ?? [], memAvailMiB: inventory.heartbeat?.memAvailMiB ?? inventory.resources?.memAvailMiB ?? null,
        reservedMiB, browser: inventory.capabilities?.browser ?? false, profiles: inventory.profiles ?? [],
    };
}

export function serializeHost(host: RuntimeHostRow) {
    const inventory = (host.inventoryJson ?? {}) as Inventory;
    const bridgeVersion = normalizeBridgeVersion(host.bridgeVersion);
    const commands = hostCommandsFrom(inventory.commands);
    const status = host.revokedAt ? "revoked" : host.status;
    const memAvailMiB = inventory.heartbeat?.memAvailMiB ?? inventory.resources?.memAvailMiB ?? null;
    return {
        id: host.id,
        name: host.name,
        hostname: host.hostname,
        os: host.os,
        arch: host.arch,
        status,
        /** Why it is offline, when known: disconnected (socket closed) or silent (no heartbeat). */
        offlineReason: host.revokedAt ? "revoked" : host.status === "online" ? null : host.offlineReason,
        /** Connections kept replacing each other in the last 30 minutes: another machine uses this host's token. */
        duplicateDaemon: Boolean(!host.revokedAt && host.duplicateDaemonAt && Date.now() - new Date(host.duplicateDaemonAt).getTime() < 30 * 60_000),
        protocol: host.protocol,
        versions: {
            hostd: host.hostdVersion,
            installer: host.installerVersion,
            bridge: host.bridgeVersion,
            hermes: host.hermesVersion,
            latestBridge: LATEST_HERMES_BRIDGE_VERSION,
            updateState: bridgeVersion ? bridgeUpdateState({ bridgeVersion }) : "legacy",
        },
        resources: {
            cpus: inventory.resources?.cpus ?? null,
            memTotalMiB: inventory.resources?.memTotalMiB ?? null,
            memAvailMiB,
            diskFreeMiB: inventory.resources?.diskFreeMiB ?? null,
            load1: inventory.heartbeat?.load1 ?? inventory.resources?.load1 ?? null,
        },
        capabilities: {
            browser: inventory.capabilities?.browser ?? false,
            linger: inventory.capabilities?.linger ?? null,
            systemdUser: inventory.capabilities?.systemdUser ?? false,
        },
        llmProviders: inventory.llmProviders ?? [],
        profiles: (inventory.profiles ?? []).map((p) => ({
            profile: p.profile, agentId: p.agentId ?? null, topology: p.topology ?? "unknown", status: p.status ?? "unknown",
            gateway: p.gateway ?? "unknown", bridge: p.bridge ?? "unknown", bridgeVersion: p.bridgeVersion ?? null,
            legacy: Boolean(p.legacy), sameEmperor: Boolean(p.sameEmperor),
            registered: p.health?.registered ?? null, lastError: p.health?.lastError ?? null,
        })),
        conflicts: inventory.conflicts ?? [],
        /** What its daemon runs (a 0.21 daemon: restart + refresh only; the UI asks to update it to hire there). */
        commands,
        /** Whether a new agent can be hired onto it now, and how (hire dialog). */
        hire: hireReadiness({
            status, revoked: Boolean(host.revokedAt), commands, llmProviders: inventory.llmProviders ?? [], memAvailMiB,
            browser: inventory.capabilities?.browser ?? false, profiles: inventory.profiles ?? [],
        }),
        inventoryAt: inventory.receivedAt ?? null,
        lastSeenAt: host.lastSeenAt,
        createdAt: host.createdAt,
        revokedAt: host.revokedAt,
    };
}

export function serializeHostEntry(entry: HostListEntry) {
    return {
        ...serializeHost(entry.host),
        agents: entry.agents,
        runtimeNodes: entry.runtimeNodes,
        activeJobs: entry.activeJobs.map((j) => ({
            id: j.id, agentId: j.agentId, agentName: j.agentId ? entry.jobAgentNames[j.agentId] ?? null : null, command: j.command, status: j.status,
            args: j.argsJson, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt, progressTruncated: j.progressTruncated,
        })),
    };
}

export type SerializedHost = ReturnType<typeof serializeHostEntry>;
