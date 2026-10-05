// Serial protocol of the Throne Display firmware (devices/throne-display), as used by
// the browser installer over Web Serial. Pure functions only, so the whole protocol
// is unit-testable without a board or a browser.
//
// Board -> host lines this module understands:
//   [boot] firmware <version>           printed once at boot
//   [version] <version>                 reply to `version`
//   [cmd] unknown '<cmd>'               older firmware without the setup commands
//   [scan] start | [scan] {json} | [scan] done <n> | [scan] error <reason>
//   [prov] ok ... | [prov] restarting | [prov] error <reason>
//   [net] connecting to Wi-Fi '<ssid>'
//   [net] Wi-Fi connected, IP <ip> RSSI <n>
//   [net] wifi_fail <wrong_password|no_network|timeout> reason=<n>
//   [net] 200 in ...                    a successful live-feed fetch
//   [net] fetch failed code=<n> ...     a failed fetch (401/403: token rejected)

export const ESPRESSIF_USB_VENDOR_ID = 0x303a;
export const DISPLAY_BAUD_RATE = 115200;

/** Longest line the firmware accepts (its buffer is 768 bytes including the terminator). */
export const MAX_COMMAND_LENGTH = 760;

export type ScanNetwork = { ssid: string; rssi: number; secure: boolean; channel: number | null };

export type WifiFailure = "wrong_password" | "no_network" | "timeout";

export type DisplayEvent =
    | { kind: "boot" }
    | { kind: "version"; version: string }
    | { kind: "unknown_command"; command: string }
    | { kind: "scan_start" }
    | { kind: "scan_network"; network: ScanNetwork }
    | { kind: "scan_done"; count: number }
    | { kind: "scan_error"; reason: string }
    | { kind: "provision_ok" }
    | { kind: "provision_restarting" }
    | { kind: "provision_error"; reason: string }
    | { kind: "wifi_connecting" }
    | { kind: "wifi_connected"; ip: string | null }
    | { kind: "wifi_failed"; reason: WifiFailure }
    | { kind: "fetch_ok" }
    | { kind: "fetch_failed"; status: number }
    | { kind: "other"; line: string };

/** Splits decoded serial text into complete lines (CR/LF tolerant, bounded). */
export class SerialLineBuffer {
    private pending = "";
    constructor(private readonly maxLine = 4096) {}

    push(text: string): string[] {
        this.pending += text;
        const lines: string[] = [];
        let idx: number;
        while ((idx = this.pending.indexOf("\n")) >= 0) {
            lines.push(this.pending.slice(0, idx).replace(/\r$/, ""));
            this.pending = this.pending.slice(idx + 1);
        }
        // A runaway line (binary noise, a boot ROM dump) never grows without bound.
        if (this.pending.length > this.maxLine) {
            lines.push(this.pending);
            this.pending = "";
        }
        return lines;
    }
}

function parseScanNetwork(json: string): ScanNetwork | null {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.ssid !== "string" || !r.ssid) return null;
    if (typeof r.rssi !== "number" || !Number.isFinite(r.rssi)) return null;
    return {
        ssid: r.ssid,
        rssi: r.rssi,
        secure: r.secure !== false,
        channel: typeof r.ch === "number" ? r.ch : null,
    };
}

const WIFI_FAILURES: readonly WifiFailure[] = ["wrong_password", "no_network", "timeout"];

export function parseDisplayLine(input: string): DisplayEvent {
    const line = input.trim();
    let m: RegExpMatchArray | null;
    if (line === "=== Emperor Claw Throne Display ===") return { kind: "boot" };
    if ((m = line.match(/^\[(?:version\]|boot\] firmware) (\S+)$/))) return { kind: "version", version: m[1] };
    if ((m = line.match(/^\[cmd\] unknown '([^']*)'/))) return { kind: "unknown_command", command: m[1] };

    if (line === "[scan] start") return { kind: "scan_start" };
    if ((m = line.match(/^\[scan\] done (\d+)$/))) return { kind: "scan_done", count: Number(m[1]) };
    if ((m = line.match(/^\[scan\] error (\S+)/))) return { kind: "scan_error", reason: m[1] };
    if (line.startsWith("[scan] {")) {
        const network = parseScanNetwork(line.slice("[scan] ".length));
        return network ? { kind: "scan_network", network } : { kind: "other", line };
    }

    if (line === "[prov] ok" || line.startsWith("[prov] ok ")) return { kind: "provision_ok" };
    if (line === "[prov] restarting") return { kind: "provision_restarting" };
    if ((m = line.match(/^\[prov\] error (\S+)/))) return { kind: "provision_error", reason: m[1] };

    if (line.startsWith("[net] connecting to Wi-Fi")) return { kind: "wifi_connecting" };
    if ((m = line.match(/^\[net\] Wi-Fi connected(?:, IP (\S+))?/))) return { kind: "wifi_connected", ip: m[1] ?? null };
    if ((m = line.match(/^\[net\] wifi_fail (\S+)/))) {
        const reason = (WIFI_FAILURES as readonly string[]).includes(m[1]) ? (m[1] as WifiFailure) : "timeout";
        return { kind: "wifi_failed", reason };
    }
    if (/^\[net\] 200 /.test(line)) return { kind: "fetch_ok" };
    if ((m = line.match(/^\[net\] fetch failed code=(-?\d+)/))) return { kind: "fetch_failed", status: Number(m[1]) };
    return { kind: "other", line };
}

/** One entry per SSID (the strongest), strongest first; hidden networks dropped. */
export function mergeScanNetworks(networks: readonly ScanNetwork[]): ScanNetwork[] {
    const best = new Map<string, ScanNetwork>();
    for (const n of networks) {
        if (!n.ssid) continue;
        const prev = best.get(n.ssid);
        if (!prev || n.rssi > prev.rssi) best.set(n.ssid, n);
    }
    return [...best.values()].sort((a, b) => b.rssi - a.rssi || a.ssid.localeCompare(b.ssid));
}

/** 1 (weak) to 4 (excellent) bars. */
export function signalBars(rssi: number): 1 | 2 | 3 | 4 {
    if (rssi >= -55) return 4;
    if (rssi >= -67) return 3;
    if (rssi >= -75) return 2;
    return 1;
}

// ---------------------------------------------------------------- server URL policy

/** 10.x, 172.16-31.x, 192.168.x or a *.local name: same rule as the firmware. */
export function isPrivateNetworkHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    if (host.length > 6 && host.endsWith(".local")) return true;
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const [a, b, c, d] = m.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return false;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Whether the display may send its token to this server: always over https
 * (the firmware verifies the certificate), over plain http only on a private
 * network. Returns a user-facing reason when not.
 */
export function checkDisplayServer(server: string): { ok: true } | { ok: false; error: string } {
    let url: URL;
    try {
        url = new URL(server);
    } catch {
        return { ok: false, error: "The server URL is not valid." };
    }
    if (url.username || url.password) return { ok: false, error: "The server URL must not contain a user name or password." };
    if (url.protocol === "https:") return { ok: true };
    if (url.protocol === "http:" && isPrivateNetworkHost(url.hostname)) return { ok: true };
    if (url.protocol === "http:") {
        return {
            ok: false,
            error: `This page is served over plain http:// from ${url.hostname}, so the display's key would travel unencrypted. Open Emperor Claw through its https:// address (or a private-network address such as 192.168.x.x) and set up the display from there.`,
        };
    }
    return { ok: false, error: "The server URL must start with https:// (or http:// on a private network)." };
}

// ---------------------------------------------------------------- provisioning

export type ProvisionInput = { ssid: string; password: string; server: string; token: string };

export type ProvisionEncoding = { ok: true; command: string } | { ok: false; field: "ssid" | "password" | "server" | "token" | "length"; error: string };

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

/**
 * Builds the single `provision <base64>` line that sets Wi-Fi, server and token at
 * once. The limits mirror the firmware's Config buffers so the board never rejects
 * what this accepts. The returned command contains secrets: never log it.
 */
export function encodeProvisionCommand(input: ProvisionInput): ProvisionEncoding {
    const ssid = input.ssid;
    const server = input.server.trim().replace(/\/+$/, "");
    const token = input.token.trim();
    const ssidLen = utf8Length(ssid);
    if (ssidLen < 1 || ssidLen > 32) return { ok: false, field: "ssid", error: "The network name must be 1 to 32 bytes." };
    const passLen = utf8Length(input.password);
    if ((passLen > 0 && passLen < 8) || passLen > 64) {
        return { ok: false, field: "password", error: "Wi-Fi passwords are 8 to 64 characters (leave it empty for an open network)." };
    }
    if (!/^https?:\/\/[^\s/]+/.test(server) || utf8Length(server) > 127) {
        return { ok: false, field: "server", error: "The server URL must start with http:// or https:// and be at most 127 characters." };
    }
    const serverCheck = checkDisplayServer(server);
    if (!serverCheck.ok) return { ok: false, field: "server", error: serverCheck.error };
    if (!token || utf8Length(token) > 199 || /\s/.test(token)) return { ok: false, field: "token", error: "The display token is missing or invalid." };
    const json = JSON.stringify({ v: 1, ssid, pass: input.password, server, token });
    const command = `provision ${toBase64(new TextEncoder().encode(json))}`;
    if (command.length > MAX_COMMAND_LENGTH) return { ok: false, field: "length", error: "These settings are too long for the display." };
    return { ok: true, command };
}

// ---------------------------------------------------------------- provisioning progress

export type ProvisionFailure = "rejected_config" | "wrong_password" | "no_network" | "wifi_timeout" | "token_rejected";

export type ProvisionProgress = {
    phase: "sending" | "restarting" | "joining_wifi" | "wifi_connected" | "live" | "failed";
    failure: ProvisionFailure | null;
    /** Firmware reason for rejected_config, e.g. "pass". */
    detail: string | null;
    /** Last non-2xx HTTP status (or negative client error) seen while connected. */
    lastFetchStatus: number | null;
};

export const initialProvisionProgress: ProvisionProgress = { phase: "sending", failure: null, detail: null, lastFetchStatus: null };

const WIFI_FAILURE_MAP: Record<WifiFailure, ProvisionFailure> = {
    wrong_password: "wrong_password",
    no_network: "no_network",
    timeout: "wifi_timeout",
};

/**
 * Folds board events into the provisioning outcome. `live` is final. A Wi-Fi
 * failure is shown but not final: the firmware keeps retrying, so a later
 * `Wi-Fi connected` (e.g. a slow router) still moves on.
 */
export function advanceProvision(state: ProvisionProgress, event: DisplayEvent): ProvisionProgress {
    if (state.phase === "live") return state;
    switch (event.kind) {
        case "provision_error":
            return { ...state, phase: "failed", failure: "rejected_config", detail: event.reason };
        case "provision_ok":
        case "provision_restarting":
            return state.phase === "sending" ? { ...state, phase: "restarting" } : state;
        case "boot":
        case "wifi_connecting":
            if (state.phase === "sending" || state.phase === "restarting") return { ...state, phase: "joining_wifi" };
            return state;
        case "wifi_connected":
            if (state.failure === "rejected_config" || state.failure === "token_rejected") return state;
            return { ...state, phase: "wifi_connected", failure: null, detail: null };
        case "wifi_failed":
            if (state.phase === "wifi_connected" || state.failure === "rejected_config") return state;
            return { ...state, phase: "failed", failure: WIFI_FAILURE_MAP[event.reason], detail: null };
        case "fetch_ok":
            return { phase: "live", failure: null, detail: null, lastFetchStatus: 200 };
        case "fetch_failed":
            if (event.status === 401 || event.status === 403) {
                return { ...state, phase: "failed", failure: "token_rejected", lastFetchStatus: event.status };
            }
            return { ...state, lastFetchStatus: event.status };
        default:
            return state;
    }
}

/** True when the board reports exactly the firmware the app ships. */
export function isFirmwareCurrent(reported: string | null | undefined, shipped: string): boolean {
    return !!reported && reported.trim() === shipped.trim();
}
