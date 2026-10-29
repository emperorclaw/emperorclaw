// Runtime hosts as the API returns them (0.21): no token hash, inventory
// trimmed to what the Settings tab shows. Pure.

import { bridgeUpdateState, normalizeBridgeVersion, LATEST_HERMES_BRIDGE_VERSION } from "@/lib/hermes-bridge-version";
import type { HostListEntry, RuntimeHostRow } from "./store";

type Inventory = {
    receivedAt?: string;
    resources?: { cpus?: number | null; memTotalMiB?: number | null; memAvailMiB?: number | null; diskFreeMiB?: number | null; load1?: number | null };
    capabilities?: { browser?: boolean; linger?: boolean | null; systemdUser?: boolean };
    llmProviders?: string[];
    profiles?: { profile: string; agentId?: string | null; topology?: string; status?: string; gateway?: string; bridge?: string; bridgeVersion?: string | null; legacy?: boolean; sameEmperor?: boolean; health?: { registered?: boolean | null; lastError?: string | null } }[];
    conflicts?: { profile: string; agentId: string; reason: string }[];
    heartbeat?: { memAvailMiB?: number | null; load1?: number | null; at?: string } | null;
};

export function serializeHost(host: RuntimeHostRow) {
    const inventory = (host.inventoryJson ?? {}) as Inventory;
    const bridgeVersion = normalizeBridgeVersion(host.bridgeVersion);
    return {
        id: host.id,
        name: host.name,
        hostname: host.hostname,
        os: host.os,
        arch: host.arch,
        status: host.revokedAt ? "revoked" : host.status,
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
            memAvailMiB: inventory.heartbeat?.memAvailMiB ?? inventory.resources?.memAvailMiB ?? null,
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
        activeJobs: entry.activeJobs.map((j) => ({ id: j.id, agentId: j.agentId, command: j.command, status: j.status, args: j.argsJson, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt, progressTruncated: j.progressTruncated })),
    };
}

export type SerializedHost = ReturnType<typeof serializeHostEntry>;
