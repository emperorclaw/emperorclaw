// The runtime host protocol (0.21; 0.22 adds hello.commands and result.tokenSha256): JSON frames on /api/hosts/ws between the
// host daemon (emperor_hostd, Python) and this server. Pure and DB-free so it
// is unit-testable and shared by server.ts and the routes.
//
// Host -> server: hello, inventory, heartbeat, ack, progress, result.
// Server -> host: welcome, command, inventory_request.
// Close codes: 4401 revoked by Emperor after a successful upgrade (the daemon
// exits 78 and systemd does not restart it), 4403 hello from a machine whose
// fingerprint does not match the paired one (retryable, slow backoff: the
// fingerprint is not a secret, this is defence in depth only), 4409 replaced
// by a newer socket of the same host, 4429 frame flood, 4400 protocol error.

import { z } from "zod";

export const HOST_PROTOCOL = 1;
export const SUPPORTED_HOST_PROTOCOLS: readonly number[] = [1];

export const CLOSE_HOST_PROTOCOL_ERROR = 4400;
export const CLOSE_HOST_REVOKED = 4401;
export const CLOSE_HOST_FINGERPRINT = 4403;
export const CLOSE_HOST_REPLACED = 4409;
export const CLOSE_HOST_RATE_LIMITED = 4429;

/** Seconds between heartbeats / full inventories the server asks for in welcome. */
export const HOST_HEARTBEAT_SEC = 30;
export const HOST_INVENTORY_SEC = 300;
/** A socket that sends no hello in this time is closed. */
export const HOST_HELLO_TIMEOUT_MS = 15_000;
/** Largest frame a host may send: an inventory (64 profiles stay far below). */
export const HOST_MAX_PAYLOAD = 256 * 1024;
/**
 * Largest non-inventory frame. A result carries an 8 KiB log tail that JSON
 * escaping can grow, so 32 KiB rather than 16.
 */
export const HOST_MAX_SMALL_FRAME = 32 * 1024;
/** Per-socket frame budget: a token bucket of this many frames, refilled per second. */
export const HOST_FRAME_BURST = 100;
export const HOST_FRAMES_PER_SEC = 20;
/** Frames queued behind the one being handled before the socket is closed. */
export const HOST_MAX_PENDING_FRAMES = 100;
/** Live host sockets per company on one server instance. */
export const HOST_MAX_SOCKETS_PER_COMPANY = 50;
/** Progress lines kept per job; later ones are dropped and the job is marked truncated. */
export const HOST_MAX_PROGRESS_EVENTS = 2000;
/** logTail in a result is clipped to this many bytes (the daemon already clips). */
export const HOST_LOG_TAIL_MAX = 8 * 1024;

const shortText = (max: number) => z.string().max(max);
const optText = (max: number) => z.string().max(max).nullish();
const count = z.number().int().min(0).max(1_000_000_000);
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const profileName = z.string().regex(PROFILE_NAME_RE);

export const hostJobStateSchema = z.object({
    jobId: UUID,
    state: z.enum(["running", "done"]),
    lastSeq: z.number().int().min(0).max(1_000_000).default(0),
});

export const helloFrameSchema = z.object({
    type: z.literal("hello"),
    protocol: z.number().int().min(0).max(1000),
    hostdVersion: shortText(40),
    installerVersion: optText(40),
    bridgeVersion: optText(40),
    hermesVersion: optText(40),
    hostFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    hostname: shortText(255),
    os: optText(80),
    arch: optText(40),
    jobs: z.array(hostJobStateSchema).max(200).default([]),
    /**
     * The commands this daemon runs (0.22+). Absent on a 0.21 daemon, which
     * runs restart_agent and refresh_inventory only (commands.hostCommandsFrom).
     */
    commands: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(32).optional(),
});

export const inventoryProfileSchema = z.object({
    profile: profileName,
    agentId: UUID.nullish(),
    /** The profile's EMPEROR_CLAW_API_URL points at the same Emperor as the daemon. */
    sameEmperor: z.boolean().default(false),
    topology: z.enum(["standalone", "shared", "unknown"]).default("unknown"),
    status: shortText(40).default("unknown"),
    gateway: shortText(40).default("unknown"),
    bridge: shortText(40).default("unknown"),
    bridgeVersion: optText(40),
    health: z.object({
        registered: z.boolean().nullish(),
        lastError: optText(500),
    }).default({}),
    /** A bridge 0.3 profile (not managed by emperor-hermes): reported, never acted on. */
    legacy: z.boolean().default(false),
});

export const inventoryFrameSchema = z.object({
    type: z.literal("inventory"),
    resources: z.object({
        cpus: count.nullish(),
        memTotalMiB: count.nullish(),
        memAvailMiB: count.nullish(),
        diskFreeMiB: count.nullish(),
        load1: z.number().min(0).max(100_000).nullish(),
    }).default({}),
    capabilities: z.object({
        browser: z.boolean().default(false),
        linger: z.boolean().nullish(),
        systemdUser: z.boolean().default(false),
    }).default({ browser: false, systemdUser: false }),
    /** Provider NAMES only (deepseek, openai, ...): never a key. */
    llmProviders: z.array(z.string().regex(/^[a-z0-9_-]{1,40}$/)).max(32).default([]),
    profiles: z.array(inventoryProfileSchema).max(64).default([]),
});

export const heartbeatFrameSchema = z.object({
    type: z.literal("heartbeat"),
    memAvailMiB: count.nullish(),
    load1: z.number().min(0).max(100_000).nullish(),
    activeJobId: UUID.nullish(),
});

export const ackFrameSchema = z.object({
    type: z.literal("ack"),
    jobId: UUID,
    accepted: z.boolean(),
    reason: optText(200),
});

export const progressFrameSchema = z.object({
    type: z.literal("progress"),
    jobId: UUID,
    seq: z.number().int().min(1).max(1_000_000),
    step: optText(300),
    line: optText(1000),
});

export const resultFrameSchema = z.object({
    type: z.literal("result"),
    jobId: UUID,
    ok: z.boolean(),
    exitCode: z.number().int().min(-1000).max(1000).nullish(),
    errorCode: optText(80),
    summary: optText(500),
    logTail: z.string().max(HOST_LOG_TAIL_MAX * 2).nullish(),
    /** The systemd units the job restarted (a shared bridge/gateway serves every agent on it). */
    units: z.array(z.string().regex(/^[\w@.-]{1,120}$/)).max(20).nullish(),
    /** provision_agent: sha256 of the agent token the new profile holds (Emperor keeps it, revokes any other). */
    tokenSha256: z.string().regex(/^[0-9a-f]{64}$/).nullish(),
});

export const hostFrameSchema = z.discriminatedUnion("type", [
    helloFrameSchema, inventoryFrameSchema, heartbeatFrameSchema, ackFrameSchema, progressFrameSchema, resultFrameSchema,
]);

export type HelloFrame = z.infer<typeof helloFrameSchema>;
export type InventoryFrame = z.infer<typeof inventoryFrameSchema>;
export type InventoryProfile = z.infer<typeof inventoryProfileSchema>;
export type HeartbeatFrame = z.infer<typeof heartbeatFrameSchema>;
export type AckFrame = z.infer<typeof ackFrameSchema>;
export type ProgressFrame = z.infer<typeof progressFrameSchema>;
export type ResultFrame = z.infer<typeof resultFrameSchema>;
export type HostFrame = z.infer<typeof hostFrameSchema>;

/** Parse one text frame from a host; null when it is not valid JSON or not a known frame. */
export function parseHostFrame(raw: string): HostFrame | null {
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch {
        return null;
    }
    const parsed = hostFrameSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
}

export type WelcomeFrame = {
    type: "welcome";
    hostId: string;
    protocol: number;
    serverVersion: string;
    bridge: { latest: string; minimum: string; hermes: string; deprecated: string[] };
    heartbeatSec: number;
    inventorySec: number;
    /** The host speaks a protocol this server does not: only update_runtime is allowed. */
    upgradeRequired?: boolean;
};

export type CommandFrame = {
    type: "command";
    jobId: string;
    command: string;
    args: Record<string, unknown>;
    deadlineSec: number;
};

export type InventoryRequestFrame = { type: "inventory_request" };

export type ServerFrame = WelcomeFrame | CommandFrame | InventoryRequestFrame;

/** Drop anything that looks like a secret from text a host sent (defence in depth; the daemon redacts first). */
export function redactHostText(text: string | null | undefined, max = 1000): string | null {
    if (text == null) return null;
    const clipped = text.length > max ? text.slice(text.length - max) : text;
    return clipped
        .replace(/\b(ech|ec)_[A-Za-z0-9_]{16,}\b/g, "[redacted]")
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
        .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
        .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\s*=\s*\S+/g, "$1=[redacted]");
}
