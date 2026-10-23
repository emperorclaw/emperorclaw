import { isVersionNewer } from "@/lib/semver";

/**
 * Hermes bridge versions this server knows about, for the register handshake
 * and the agent card badges (docs/design/hermes-persistent-runtime.md §4.6).
 * Kept free of DB imports so it is unit-testable and safe in client bundles.
 *
 * Bump LATEST with every bridge release; raise MINIMUM only when the server
 * drops support for an older bridge protocol.
 */
export const LATEST_HERMES_BRIDGE_VERSION = "0.9.2";
export const MIN_HERMES_BRIDGE_VERSION = "0.9.0";
/** The bridge protocol LATEST speaks (bridge `BRIDGE_PROTOCOL`). */
export const HERMES_BRIDGE_PROTOCOL = 2;
/** The Hermes release every 0.9 runtime is pinned to. */
export const PINNED_HERMES_VERSION = "v0.22.4";
export const PINNED_HERMES_SHA = "4d04303818b61bf3aa09278af48356315515965b";
/**
 * Release series still served but deprecated: bridge 0.3.x never reports a
 * version, keeps working with 0.9.x and stops in 0.10.0.
 */
export const DEPRECATED_HERMES_BRIDGE_SERIES = ["0.3"] as const;

export type BridgeUpdateState = "current" | "update-available" | "unsupported" | "legacy";

/** `bridge` block of the POST /api/mcp/runtime/register response. */
export interface HermesBridgeInfo {
    latest: string;
    minimum: string;
    hermes: string;
    deprecated: string[];
}

export function hermesBridgeInfo(): HermesBridgeInfo {
    return {
        latest: LATEST_HERMES_BRIDGE_VERSION,
        minimum: MIN_HERMES_BRIDGE_VERSION,
        hermes: PINNED_HERMES_VERSION,
        deprecated: [...DEPRECATED_HERMES_BRIDGE_SERIES],
    };
}

const VERSION_RE = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/;

/** "v0.9.0", "0.9.0-rc.1" → "0.9.0"; null when not a dotted version. */
export function normalizeBridgeVersion(value: string | null | undefined): string | null {
    const match = VERSION_RE.exec(String(value ?? "").trim());
    if (!match) return null;
    return `${Number(match[1])}.${Number(match[2])}.${Number(match[3] ?? 0)}`;
}

/**
 * The badge state of a runtime node:
 * - `legacy`: no bridge version reported (bridge 0.3.x never sends one);
 * - `unsupported`: older than MINIMUM, or not a version at all;
 * - `update-available`: supported but older than LATEST;
 * - `current`: LATEST or newer.
 */
export function bridgeUpdateState(
    node: { bridgeVersion?: string | null },
    latest: string = LATEST_HERMES_BRIDGE_VERSION,
    minimum: string = MIN_HERMES_BRIDGE_VERSION,
): BridgeUpdateState {
    const raw = node.bridgeVersion?.trim();
    if (!raw) return "legacy";
    const version = normalizeBridgeVersion(raw);
    if (!version) return "unsupported";
    if (isVersionNewer(minimum, version)) return "unsupported";
    if (isVersionNewer(latest, version)) return "update-available";
    return "current";
}
