import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { DEPLOYMENT_MODE } from "@/lib/env";
import { DOCKER_HOST_ALIAS } from "@/lib/llm-endpoint";

/**
 * Which hosts a custom model endpoint may point at, server side.
 *
 * An admin's base URL is fetched by this server (the endpoint check in
 * src/lib/onboarding.ts) and by the agent's container, so it must never name
 * cloud metadata, link-local, multicast or unspecified addresses, nor this
 * stack's own services (the database, the app itself). A self-hosted install
 * may point at its LAN and at the Docker host (Ollama, LM Studio on the same
 * machine); a cloud install may only point at public addresses.
 *
 * The check runs on the resolved addresses, not the spelling: the URL parser
 * already turns decimal, octal and hex IPv4 into dotted form, and every name
 * is resolved (all records) and each address classified. The server's own
 * request then connects to the checked address (pinnedGet), so a DNS answer
 * that changes between the check and the request cannot redirect it.
 */

export type EndpointMode = "self-hosted" | "cloud";

/** blocked: never; loopback/private: self-hosted only; public: always. */
export type AddressClass = "public" | "private" | "loopback" | "blocked";

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type LookupAll = (hostname: string) => Promise<ResolvedAddress[]>;

export type EndpointHostCheck =
    | { ok: true; hostname: string; addresses: ResolvedAddress[] }
    | { ok: false; reason: "blocked" | "unresolved"; error: string };

/** Cloud metadata services, by name (their addresses are link-local and blocked as such too). */
const METADATA_NAMES = new Set([
    "metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal",
    "metadata.azure.internal", "metadata.oraclecloud.com",
]);

/** This stack's Docker Compose services (docker-compose.yml): an agent's container may resolve them. */
const STACK_SERVICE_NAMES = new Set(["postgres", "app", "caddy", "drive-sync", "emperorclaw"]);

/** Docker's names for the host machine. */
const DOCKER_HOST_NAMES = new Set([DOCKER_HOST_ALIAS, "gateway.docker.internal", "host-gateway"]);

const BLOCKED_ERROR = "This address can't be used for a model endpoint: it is link-local, cloud metadata, multicast, unspecified, or one of this app's own services.";
const CLOUD_PRIVATE_ERROR = "On this installation a model endpoint must have a public address; private, local and Docker host addresses are only allowed on self-hosted installs.";
const UNRESOLVED_ERROR = "That host name doesn't resolve from this server.";

/** A dotted-quad IPv4 address as an unsigned 32-bit number; null for anything else. */
export function ipv4ToInt(address: string): number | null {
    const parts = address.split(".");
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        value = value * 256 + octet;
    }
    return value;
}

function inV4(value: number, base: string, prefix: number): boolean {
    const start = ipv4ToInt(base)!;
    const size = 2 ** (32 - prefix);
    return value >= start && value < start + size;
}

export function classifyIPv4(address: string): AddressClass {
    const value = ipv4ToInt(address);
    if (value === null) return "blocked";
    if (inV4(value, "0.0.0.0", 8)) return "blocked"; // "this network", incl. 0.0.0.0
    if (inV4(value, "127.0.0.0", 8)) return "loopback";
    if (inV4(value, "169.254.0.0", 16)) return "blocked"; // link-local, cloud metadata
    if (inV4(value, "224.0.0.0", 4)) return "blocked"; // multicast
    if (inV4(value, "240.0.0.0", 4)) return "blocked"; // reserved, broadcast
    if (inV4(value, "10.0.0.0", 8) || inV4(value, "172.16.0.0", 12) || inV4(value, "192.168.0.0", 16)) return "private";
    if (inV4(value, "100.64.0.0", 10) || inV4(value, "198.18.0.0", 15)) return "private"; // CGNAT, benchmarking
    return "public";
}

/** An IPv6 address as eight 16-bit groups (a trailing dotted IPv4 is folded in); null when malformed. */
export function ipv6Groups(address: string): number[] | null {
    let text = address.toLowerCase().replace(/^\[|\]$/g, "");
    const zone = text.indexOf("%");
    if (zone >= 0) text = text.slice(0, zone);
    const lastColon = text.lastIndexOf(":");
    if (lastColon < 0) return null;
    const tail = text.slice(lastColon + 1);
    if (tail.includes(".")) {
        const v4 = ipv4ToInt(tail);
        if (v4 === null) return null;
        text = `${text.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    }
    const halves = text.split("::");
    if (halves.length > 2) return null;
    const parse = (part: string) => (part ? part.split(":") : []);
    const left = parse(halves[0]);
    const right = halves.length === 2 ? parse(halves[1]) : [];
    const missing = 8 - left.length - right.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
    const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
    const out: number[] = [];
    for (const group of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
        out.push(parseInt(group, 16));
    }
    return out.length === 8 ? out : null;
}

function embeddedV4(groups: number[], from: number): string {
    return [groups[from] >> 8, groups[from] & 0xff, groups[from + 1] >> 8, groups[from + 1] & 0xff].join(".");
}

export function classifyIPv6(address: string): AddressClass {
    const g = ipv6Groups(address);
    if (!g) return "blocked";
    const zeroUpTo = (n: number) => g.slice(0, n).every((v) => v === 0);
    if (zeroUpTo(8)) return "blocked"; // ::
    if (zeroUpTo(7) && g[7] === 1) return "loopback"; // ::1
    if (zeroUpTo(5) && g[5] === 0xffff) return classifyIPv4(embeddedV4(g, 6)); // ::ffff:a.b.c.d (mapped)
    if (zeroUpTo(6)) return classifyIPv4(embeddedV4(g, 6)); // ::a.b.c.d (compatible, deprecated)
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((v) => v === 0)) return classifyIPv4(embeddedV4(g, 6)); // NAT64
    if (g[0] === 0x2002) { // 6to4 carries an IPv4 address in groups 1-2
        const inner = classifyIPv4(embeddedV4(g, 1));
        return inner === "public" ? "public" : "blocked";
    }
    if ((g[0] & 0xffc0) === 0xfe80) return "blocked"; // link-local
    if ((g[0] & 0xff00) === 0xff00) return "blocked"; // multicast
    if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfec0) return "private"; // unique local, old site-local
    return "public";
}

export function classifyAddress(address: string): AddressClass {
    const family = net.isIP(address.replace(/^\[|\]$/g, "").split("%")[0]);
    if (family === 4) return classifyIPv4(address);
    if (family === 6) return classifyIPv6(address);
    return "blocked";
}

/** Lowercase, without IPv6 brackets or trailing dots ("metadata.google.internal." is the same host). */
export function normalizeEndpointHostname(hostname: string): string {
    let host = hostname.trim().toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    let end = host.length;
    while (end > 0 && host.charCodeAt(end - 1) === 46 /* "." */) end--;
    return host.slice(0, end);
}

/** Ports of this app and its database on the loopback interface: never a model endpoint. */
function ownLoopbackPorts(): Set<number> {
    const ports = new Set<number>([Number(process.env.PORT) || 3000]);
    try {
        const db = new URL(process.env.POSTGRES_CONNECTION_STRING || "");
        const host = normalizeEndpointHostname(db.hostname);
        if (host === "localhost" || classifyAddress(host) === "loopback") ports.add(Number(db.port) || 5432);
    } catch { /* no or unparsable connection string */ }
    return ports;
}

function urlPort(url: URL): number {
    return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
}

/** Whether one resolved address may be used in this mode; an error message when not. */
export function addressDecision(address: string, mode: EndpointMode, port: number, ownPorts: Set<number> = ownLoopbackPorts()): string | null {
    const cls = classifyAddress(address);
    if (cls === "blocked") return BLOCKED_ERROR;
    if (cls === "public") return null;
    if (mode === "cloud") return CLOUD_PRIVATE_ERROR;
    if (cls === "loopback" && ownPorts.has(port)) return BLOCKED_ERROR;
    return null;
}

const defaultLookup: LookupAll = async (hostname) => {
    const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/**
 * Check a base URL's host for `mode` (DEPLOYMENT_MODE by default): names on
 * the deny lists first, then every address the name resolves to. An IP
 * literal is classified as is. `unresolved` means the name doesn't resolve
 * from this server, which an agent container may still manage (the caller
 * decides).
 */
export async function checkLlmEndpointHost(
    baseUrl: string,
    options: { mode?: EndpointMode; lookup?: LookupAll; ownPorts?: Set<number> } = {},
): Promise<EndpointHostCheck> {
    const mode = options.mode ?? DEPLOYMENT_MODE;
    let url: URL;
    try {
        url = new URL(baseUrl);
    } catch {
        return { ok: false, reason: "blocked", error: "That is not a URL." };
    }
    const hostname = normalizeEndpointHostname(url.hostname);
    const port = urlPort(url);
    const ownPorts = options.ownPorts ?? ownLoopbackPorts();
    if (!hostname) return { ok: false, reason: "blocked", error: BLOCKED_ERROR };

    const literal = net.isIP(hostname);
    if (literal) {
        const denied = addressDecision(hostname, mode, port, ownPorts);
        return denied ? { ok: false, reason: "blocked", error: denied } : { ok: true, hostname, addresses: [{ address: hostname, family: literal === 6 ? 6 : 4 }] };
    }
    if (METADATA_NAMES.has(hostname) || STACK_SERVICE_NAMES.has(hostname)) return { ok: false, reason: "blocked", error: BLOCKED_ERROR };
    if (DOCKER_HOST_NAMES.has(hostname) && mode === "cloud") return { ok: false, reason: "blocked", error: CLOUD_PRIVATE_ERROR };
    // localhost is the loopback interface whatever a resolver says.
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
        const denied = addressDecision("127.0.0.1", mode, port, ownPorts);
        return denied ? { ok: false, reason: "blocked", error: denied } : { ok: true, hostname, addresses: [{ address: "127.0.0.1", family: 4 }] };
    }

    let addresses: ResolvedAddress[];
    try {
        addresses = await (options.lookup ?? defaultLookup)(hostname);
    } catch {
        return { ok: false, reason: "unresolved", error: UNRESOLVED_ERROR };
    }
    if (addresses.length === 0) return { ok: false, reason: "unresolved", error: UNRESOLVED_ERROR };
    for (const { address } of addresses) {
        const denied = addressDecision(address, mode, port, ownPorts);
        if (denied) return { ok: false, reason: "blocked", error: denied };
    }
    return { ok: true, hostname, addresses };
}

/**
 * The policy for storing a base URL (hire, PATCH): blocked hosts are refused.
 * A name this server cannot resolve is accepted on a self-hosted install (the
 * agent's container may see LAN names this server does not) and refused in
 * cloud mode, where nothing private is allowed anyway.
 */
export async function checkLlmEndpointForSave(
    baseUrl: string,
    options: { mode?: EndpointMode; lookup?: LookupAll; ownPorts?: Set<number> } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
    const mode = options.mode ?? DEPLOYMENT_MODE;
    const checked = await checkLlmEndpointHost(baseUrl, { ...options, mode });
    if (checked.ok) return { ok: true };
    if (checked.reason === "unresolved" && mode === "self-hosted") return { ok: true };
    return { ok: false, error: checked.error };
}

const PINNED_MAX_BODY_BYTES = 1024 * 1024;

/**
 * GET `url`, connecting only to `target` (an address checkLlmEndpointHost
 * accepted). The Host header and TLS server name stay the URL's host name; no
 * redirect is followed; the body is capped at 1 MB.
 */
export function pinnedGet(url: string, target: ResolvedAddress, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const transport = parsed.protocol === "https:" ? https : http;
        const lookup: net.LookupFunction = (_hostname, options, callback) => {
            const cb = callback as (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
            if ((options as dns.LookupOptions | undefined)?.all) cb(null, [{ address: target.address, family: target.family }]);
            else cb(null, target.address, target.family);
        };
        const req = transport.request(parsed, { method: "GET", headers, lookup, agent: false, timeout: timeoutMs }, (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > PINNED_MAX_BODY_BYTES) {
                    req.destroy(new Error("response too large"));
                    return;
                }
                chunks.push(chunk);
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", reject);
        });
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", reject);
        req.end();
    });
}
