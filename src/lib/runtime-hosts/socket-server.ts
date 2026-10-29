// The runtime host socket (/api/hosts/ws, 0.21+): one socket per paired host,
// authenticated with the host token (never a company token), carrying real
// upstream frames (lib/runtime-hosts/protocol.ts). It is NOT a CompanySocket:
// it never receives mcp_events. server.ts mounts it; the integration tests
// mount it on a plain http server.
//
// Jobs reach the socket through the database: a route inserts a job and
// pg_notify('host_jobs', {hostId}); every instance's listener calls
// handleNotification and the one holding the host's socket dispatches.
// Revocation does not depend on that NOTIFY alone: every heartbeat/inventory
// and the 30 s sweep tick re-check that the host is still live.
//
// A paired host is still untrusted input: upgrades are rate limited per IP,
// sockets are capped per company, frames are rate limited per socket (token
// bucket), the queue of frames waiting to be handled is bounded, and frames
// other than an inventory must be small.

import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import pkg from "@/../package.json" assert { type: "json" };
import { hermesBridgeInfo } from "@/lib/hermes-bridge-version";
import { consumeRateLimit } from "@/lib/rate-limit";
import { bearerToken, isHostTokenShape } from "./pairing";
import {
    CLOSE_HOST_FINGERPRINT, CLOSE_HOST_PROTOCOL_ERROR, CLOSE_HOST_RATE_LIMITED, CLOSE_HOST_REPLACED, CLOSE_HOST_REVOKED,
    HOST_FRAME_BURST, HOST_FRAMES_PER_SEC, HOST_HEARTBEAT_SEC, HOST_HELLO_TIMEOUT_MS, HOST_INVENTORY_SEC, HOST_MAX_PAYLOAD,
    HOST_MAX_PENDING_FRAMES, HOST_MAX_SMALL_FRAME, HOST_MAX_SOCKETS_PER_COMPANY, HOST_PROTOCOL, SUPPORTED_HOST_PROTOCOLS, parseHostFrame,
    type CommandFrame, type ServerFrame, type WelcomeFrame,
} from "./protocol";
import {
    applyAck, applyProgress, applyResult, authenticateHostToken, claimNextJob, deadHostIds, markDuplicateDaemon, notifyHost,
    parseHostNotification, reconcileHostJobs, recordDisconnect, recordHeartbeat, recordHello, recordInventory, sweepRuntimeHosts,
    type HostNotification, type RuntimeHostJobRow,
} from "./store";
import { COMMAND_DEADLINE_SEC, isHostCommand } from "./commands";

export const HOST_SOCKET_PATH = "/api/hosts/ws";
const SWEEP_INTERVAL_MS = 30_000;
/**
 * Failed upgrades per client IP per minute (bad, unknown or revoked tokens): once over, that IP's
 * attempts are refused before any database lookup. Successful ones never count: behind a proxy
 * without TRUSTED_PROXY_IPS every host shares the proxy's IP, and one host's reconnects must not
 * lock out the others. A valid host is limited by its own key instead.
 */
const FAILED_UPGRADES_PER_IP_PER_MIN = 30;
/** Upgrades per authenticated host per minute (a reconnect storm, or two daemons on one token). */
const UPGRADES_PER_HOST_PER_MIN = 20;
/** Replacements of a live socket that mark the host as having two daemons. */
const DUPLICATE_REPLACEMENTS = 3;
const DUPLICATE_WINDOW_MS = 10 * 60_000;
/** A replaced socket counts as a live daemon when it sent a frame this recently. */
const LIVE_FRAME_MS = 60_000;

type HostSocket = WebSocket & {
    hostId?: string;
    companyId?: string;
    connectionId?: string;
    connectedAt?: Date;
    helloDone?: boolean;
    upgradeRequired?: boolean;
    isAlive?: boolean;
    lastFrameAt?: number;
    tokens?: number;
    tokensAt?: number;
    pending?: number;
    /** Already closed as replaced: counted once for duplicate-daemon detection. */
    replaced?: boolean;
};

export type HostSocketServer = {
    wss: WebSocketServer;
    /** Handle an upgrade on HOST_SOCKET_PATH (the caller matched the path). */
    handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
    /** A host_jobs NOTIFY payload (any instance may have sent it). */
    handleNotification: (payload: string | undefined) => void;
    /** Start the 30 s sweeper (server.ts; tests call sweep directly). */
    startSweeper: () => void;
    /** One sweep tick: the DB sweep, then close sockets of hosts that are no longer live. */
    sweep: () => Promise<void>;
    socketsFor: (hostId: string) => HostSocket[];
    close: () => void;
};

function rejectUpgrade(socket: Duplex, status: number, reason: string) {
    if (!socket.destroyed) {
        try {
            socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
        } catch {
            // The client already went away.
        }
    }
    socket.destroy();
}

function send(ws: WebSocket, frame: ServerFrame) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

/**
 * The command frame of a job. `sendArgs` replaces args_json when the job was
 * just claimed with a freshly minted token (provision_agent); a resend after a
 * reconnect carries args_json only (the host replays a job it knows, it never
 * runs it again, so it needs no token).
 */
function commandFrame(job: RuntimeHostJobRow, sendArgs: Record<string, unknown> | null = null): CommandFrame {
    return {
        type: "command",
        jobId: job.id,
        command: job.command,
        args: sendArgs ?? (job.argsJson ?? {}) as Record<string, unknown>,
        deadlineSec: isHostCommand(job.command) ? COMMAND_DEADLINE_SEC[job.command] : 300,
    };
}

/** Token bucket: true when the socket may send one more frame now. */
export function takeFrameToken(ws: { tokens?: number; tokensAt?: number }, now = Date.now()): boolean {
    const last = ws.tokensAt ?? now;
    const tokens = Math.min(HOST_FRAME_BURST, (ws.tokens ?? HOST_FRAME_BURST) + ((now - last) / 1000) * HOST_FRAMES_PER_SEC);
    ws.tokensAt = now;
    if (tokens < 1) {
        ws.tokens = tokens;
        return false;
    }
    ws.tokens = tokens - 1;
    return true;
}

function defaultClientIp(request: IncomingMessage): string {
    return (request.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

export function createHostSocketServer(options: {
    log?: (message: string, error?: unknown) => void;
    /** The client IP to rate-limit upgrades by (server.ts passes its trusted-proxy aware resolver). */
    clientIp?: (request: IncomingMessage) => string;
} = {}): HostSocketServer {
    const log = options.log ?? ((message: string, error?: unknown) => (error ? console.warn(message, error) : console.log(message)));
    const clientIp = options.clientIp ?? defaultClientIp;
    const wss = new WebSocketServer({ noServer: true, maxPayload: HOST_MAX_PAYLOAD });
    const byHost = new Map<string, Set<HostSocket>>();
    const replacements = new Map<string, number[]>();
    let sweeper: NodeJS.Timeout | null = null;

    const socketsFor = (hostId: string) => [...(byHost.get(hostId) ?? [])];
    const companySockets = (companyId: string) => [...wss.clients].filter((c) => (c as HostSocket).companyId === companyId).length;

    /** Close an older socket replaced by a newer one; a replaced socket that was busy talking means two daemons. */
    const replace = (old: HostSocket) => {
        // The hello handler and the "replaced" NOTIFY both reach the same old socket: count it once.
        if (old.replaced) return;
        old.replaced = true;
        const hostId = old.hostId!;
        if (old.lastFrameAt && Date.now() - old.lastFrameAt < LIVE_FRAME_MS) {
            const now = Date.now();
            const recent = (replacements.get(hostId) ?? []).filter((t) => now - t < DUPLICATE_WINDOW_MS);
            recent.push(now);
            replacements.set(hostId, recent);
            if (recent.length >= DUPLICATE_REPLACEMENTS) {
                replacements.set(hostId, []);
                void markDuplicateDaemon(hostId).catch((error) => log(`runtime host ${hostId}: duplicate flag failed`, error));
            }
        }
        old.close(CLOSE_HOST_REPLACED, "replaced by a newer connection");
    };

    /** Send the host its next job, if it has one and nothing else is running. */
    const dispatch = async (hostId: string) => {
        const ws = socketsFor(hostId).find((s) => s.helloDone && s.readyState === WebSocket.OPEN && !s.upgradeRequired);
        if (!ws) return;
        try {
            const claimed = await claimNextJob(hostId);
            if (claimed) send(ws, commandFrame(claimed.job, claimed.sendArgs));
        } catch (error) {
            log(`runtime host ${hostId}: dispatch failed`, error);
        }
    };

    const onFrame = async (ws: HostSocket, raw: string) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const frame = parseHostFrame(raw);
        const hostId = ws.hostId!;
        if (!frame) {
            ws.close(CLOSE_HOST_PROTOCOL_ERROR, "invalid frame");
            return;
        }
        if (frame.type !== "inventory" && Buffer.byteLength(raw) > HOST_MAX_SMALL_FRAME) {
            ws.close(CLOSE_HOST_PROTOCOL_ERROR, "frame too large");
            return;
        }
        if (!ws.helloDone && frame.type !== "hello") {
            ws.close(CLOSE_HOST_PROTOCOL_ERROR, "hello first");
            return;
        }
        switch (frame.type) {
            case "hello": {
                if (ws.helloDone) return;
                const outcome = await recordHello(hostId, frame, ws.connectedAt!);
                if (!outcome.ok) {
                    if (outcome.reason === "fingerprint_mismatch") ws.close(CLOSE_HOST_FINGERPRINT, "fingerprint mismatch");
                    else ws.close(CLOSE_HOST_REVOKED, outcome.reason);
                    return;
                }
                ws.helloDone = true;
                ws.upgradeRequired = !SUPPORTED_HOST_PROTOCOLS.includes(frame.protocol);
                // Any older socket of this host (here or on another instance) is replaced.
                for (const other of socketsFor(hostId)) {
                    if (other !== ws) replace(other);
                }
                await notifyHost({ kind: "replaced", hostId, connectionId: ws.connectionId! });
                const welcome: WelcomeFrame = {
                    type: "welcome",
                    hostId,
                    protocol: HOST_PROTOCOL,
                    serverVersion: pkg.version,
                    bridge: hermesBridgeInfo(),
                    heartbeatSec: HOST_HEARTBEAT_SEC,
                    inventorySec: HOST_INVENTORY_SEC,
                    ...(ws.upgradeRequired ? { upgradeRequired: true } : {}),
                };
                send(ws, welcome);
                if (ws.upgradeRequired) return;
                const resend = await reconcileHostJobs(hostId, frame.jobs);
                for (const job of resend) send(ws, commandFrame(job));
                if (resend.length === 0) await dispatch(hostId);
                return;
            }
            case "inventory":
                if (!(await recordInventory(hostId, frame))) ws.close(CLOSE_HOST_REVOKED, "revoked");
                return;
            case "heartbeat":
                if (!(await recordHeartbeat(hostId, frame))) ws.close(CLOSE_HOST_REVOKED, "revoked");
                return;
            case "ack": {
                const job = await applyAck(hostId, frame);
                // A refused or busy job frees the slot; a busy host is nudged again by the sweeper.
                if (job && job.status !== "running" && job.status !== "queued") await dispatch(hostId);
                return;
            }
            case "progress":
                await applyProgress(hostId, frame);
                return;
            case "result":
                await applyResult(hostId, frame);
                await dispatch(hostId);
                return;
        }
    };

    wss.on("connection", (socket: WebSocket) => {
        const ws = socket as HostSocket;
        ws.isAlive = true;
        ws.pending = 0;
        ws.on("pong", () => { ws.isAlive = true; });
        ws.on("error", (error) => log(`runtime host socket error: ${error.message}`));
        const hostId = ws.hostId!;
        let set = byHost.get(hostId);
        if (!set) {
            set = new Set();
            byHost.set(hostId, set);
        }
        set.add(ws);
        const helloTimer = setTimeout(() => {
            if (!ws.helloDone) ws.close(CLOSE_HOST_PROTOCOL_ERROR, "no hello");
        }, HOST_HELLO_TIMEOUT_MS);
        helloTimer.unref?.();
        // Frames are handled one at a time, in order (a result never overtakes its progress).
        let chain: Promise<void> = Promise.resolve();
        ws.on("message", (data, isBinary) => {
            ws.isAlive = true;
            ws.lastFrameAt = Date.now();
            if (isBinary) {
                ws.close(CLOSE_HOST_PROTOCOL_ERROR, "text frames only");
                return;
            }
            if (!takeFrameToken(ws)) {
                ws.close(CLOSE_HOST_RATE_LIMITED, "too many frames");
                return;
            }
            if ((ws.pending ?? 0) >= HOST_MAX_PENDING_FRAMES) {
                ws.close(CLOSE_HOST_RATE_LIMITED, "too many pending frames");
                return;
            }
            ws.pending = (ws.pending ?? 0) + 1;
            const raw = data.toString();
            chain = chain.then(() => onFrame(ws, raw)).catch((error) => log(`runtime host ${hostId}: frame failed`, error))
                .finally(() => { ws.pending = Math.max(0, (ws.pending ?? 1) - 1); });
        });
        ws.on("close", () => {
            clearTimeout(helloTimer);
            const sockets = byHost.get(hostId);
            sockets?.delete(ws);
            if (sockets && sockets.size === 0) byHost.delete(hostId);
            if (ws.helloDone && ws.connectedAt) {
                void chain.then(() => recordDisconnect(hostId, ws.connectedAt!)).catch((error) => log(`runtime host ${hostId}: disconnect failed`, error));
            }
        });
    });

    /** Failed upgrades per IP in the current minute (checked before the database, counted only on failure). */
    const failedByIp = new Map<string, { count: number; resetAt: number }>();
    const ipBlocked = (ip: string) => {
        const entry = failedByIp.get(ip);
        return Boolean(entry && entry.resetAt > Date.now() && entry.count >= FAILED_UPGRADES_PER_IP_PER_MIN);
    };
    const noteFailure = (ip: string) => {
        const now = Date.now();
        const entry = failedByIp.get(ip);
        if (!entry || entry.resetAt <= now) failedByIp.set(ip, { count: 1, resetAt: now + 60_000 });
        else entry.count += 1;
        if (failedByIp.size > 5000) for (const [key, value] of failedByIp) if (value.resetAt <= now) failedByIp.delete(key);
    };

    const handleUpgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        socket.on("error", () => socket.destroy());
        try {
            const ip = clientIp(request);
            if (ipBlocked(ip)) {
                rejectUpgrade(socket, 429, "Too Many Requests");
                return;
            }
            const token = bearerToken(request.headers.authorization);
            // A malformed token never reaches the database.
            const host = isHostTokenShape(token) ? await authenticateHostToken(token) : null;
            if (!host) {
                noteFailure(ip);
                rejectUpgrade(socket, 401, "Unauthorized");
                return;
            }
            const hostLimit = consumeRateLimit({ key: `host-ws:host:${host.id}`, limit: UPGRADES_PER_HOST_PER_MIN, windowMs: 60_000 });
            if (!hostLimit.allowed) {
                rejectUpgrade(socket, 429, "Too Many Requests");
                return;
            }
            if (companySockets(host.companyId) >= HOST_MAX_SOCKETS_PER_COMPANY && socketsFor(host.id).length === 0) {
                rejectUpgrade(socket, 429, "Too Many Requests");
                return;
            }
            if (socket.destroyed) return;
            wss.handleUpgrade(request, socket, head, (ws) => {
                const hostSocket = ws as HostSocket;
                hostSocket.hostId = host.id;
                hostSocket.companyId = host.companyId;
                hostSocket.connectionId = randomUUID();
                hostSocket.connectedAt = new Date();
                wss.emit("connection", hostSocket, request);
            });
        } catch (error) {
            log("runtime host upgrade failed", error);
            rejectUpgrade(socket, 500, "Internal Server Error");
        }
    };

    const handleNotification = (payload: string | undefined) => {
        const note: HostNotification | null = parseHostNotification(payload);
        if (!note) return;
        const sockets = socketsFor(note.hostId);
        if (sockets.length === 0) return;
        if (note.kind === "revoked") {
            for (const ws of sockets) ws.close(CLOSE_HOST_REVOKED, "revoked");
        } else if (note.kind === "replaced") {
            for (const ws of sockets) if (ws.connectionId !== note.connectionId && ws.helloDone) replace(ws);
        } else {
            void dispatch(note.hostId);
        }
    };

    /** Close sockets of hosts revoked (or whose company was deleted) even if the NOTIFY was lost. */
    const closeDeadSockets = async () => {
        const held = [...byHost.keys()];
        const dead = await deadHostIds(held);
        for (const hostId of dead) for (const ws of socketsFor(hostId)) ws.close(CLOSE_HOST_REVOKED, "revoked");
    };

    const sweep = async () => {
        try {
            await sweepRuntimeHosts();
        } catch (error) {
            log("runtime host sweep failed", error);
        }
        try {
            await closeDeadSockets();
        } catch (error) {
            log("runtime host revocation check failed", error);
        }
    };

    const liveness = setInterval(() => {
        wss.clients.forEach((client) => {
            const ws = client as HostSocket;
            if (ws.isAlive === false) {
                ws.terminate();
                return;
            }
            ws.isAlive = false;
            try {
                ws.ping();
            } catch {
                ws.terminate();
            }
        });
    }, 25_000);
    liveness.unref();

    return {
        wss,
        handleUpgrade,
        handleNotification,
        startSweeper: () => {
            if (sweeper) return;
            sweeper = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
            sweeper.unref();
        },
        sweep,
        socketsFor,
        close: () => {
            clearInterval(liveness);
            if (sweeper) clearInterval(sweeper);
            for (const ws of wss.clients) ws.terminate();
            wss.close();
        },
    };
}
