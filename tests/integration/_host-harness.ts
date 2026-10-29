/**
 * A fake runtime host daemon over a real websocket for the runtime host suites:
 * lib/runtime-hosts/socket-server.ts mounted on a plain http server, with a
 * LISTEN host_jobs client standing in for server.ts's listener, against the
 * real Postgres of the integration run.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { getDb, getSchema, makeRequest } from "./_helper";

export type Frame = Record<string, any>;
export const FP = "f".repeat(64);
/** What a 0.22 daemon advertises in hello. */
export const COMMANDS_022 = ["provision_agent", "refresh_inventory", "remove_agent", "restart_agent"];

export class FakeHost {
    frames: Frame[] = [];
    closed: { code: number; reason: string } | null = null;
    private waiters: (() => void)[] = [];
    constructor(public ws: import("ws").WebSocket) {
        ws.on("message", (data) => { this.frames.push(JSON.parse(String(data))); this.wake(); });
        ws.on("close", (code, reason) => { this.closed = { code, reason: String(reason) }; this.wake(); });
    }
    private wake() { for (const w of this.waiters.splice(0)) w(); }
    send(frame: Frame) { this.ws.send(JSON.stringify(frame)); }
    async waitFor<T>(check: () => T | undefined | null | false, ms = 5000): Promise<T> {
        const end = Date.now() + ms;
        for (;;) {
            const value = check();
            if (value) return value as T;
            if (Date.now() > end) throw new Error(`timed out; frames: ${JSON.stringify(this.frames.map((f) => f.type))} closed: ${JSON.stringify(this.closed)}`);
            await new Promise<void>((resolve) => { this.waiters.push(resolve); setTimeout(resolve, 50); });
        }
    }
    commands() { return this.frames.filter((f) => f.type === "command"); }
    /** hello of a 0.22 daemon (commands listed), or of a 0.21 one with `commands: null`. */
    hello(opts: { jobs?: Frame[]; commands?: string[] | null } = {}) {
        const commands = opts.commands === undefined ? COMMANDS_022 : opts.commands;
        const version = commands ? "0.22.0" : "0.21.0";
        this.send({
            type: "hello", protocol: 1, hostdVersion: version, installerVersion: version, bridgeVersion: version, hermesVersion: "v0.22.4",
            hostFingerprint: FP, hostname: "malecu-hermes-1", os: "Ubuntu 24.04", arch: "x86_64", jobs: opts.jobs ?? [],
            ...(commands ? { commands } : {}),
        });
    }
    async close() {
        if (this.ws.readyState === this.ws.OPEN) this.ws.close(1000);
        await this.waitFor(() => this.closed);
    }
}

export type Harness = { url: string; server: Server; close: () => Promise<void>; hostServer: import("@/lib/runtime-hosts/socket-server").HostSocketServer };

export async function harness(clientIp = `harness-${randomUUID()}`): Promise<Harness> {
    const { createHostSocketServer, HOST_SOCKET_PATH } = await import("@/lib/runtime-hosts/socket-server");
    const { HOST_JOBS_CHANNEL } = await import("@/lib/runtime-hosts/store");
    const hostServer = createHostSocketServer({ log: () => {}, clientIp: () => clientIp });
    const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
    server.on("upgrade", (req, socket, head) => {
        if ((req.url || "").split("?")[0] === HOST_SOCKET_PATH) void hostServer.handleUpgrade(req, socket, head);
        else socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { Client } = await import("pg");
    const listener = new Client({ connectionString: process.env.POSTGRES_CONNECTION_STRING });
    await listener.connect();
    listener.on("notification", (msg) => { if (msg.channel === HOST_JOBS_CHANNEL) hostServer.handleNotification(msg.payload); });
    await listener.query(`LISTEN ${HOST_JOBS_CHANNEL}`);
    const port = (server.address() as { port: number }).port;
    return {
        url: `ws://127.0.0.1:${port}${HOST_SOCKET_PATH}`, server, hostServer,
        close: async () => {
            hostServer.close();
            await new Promise((resolve) => setTimeout(resolve, 300));
            await listener.end();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

export async function connect(h: Harness, token: string): Promise<FakeHost> {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(h.url, { headers: { Authorization: `Bearer ${token}` } });
    const host = new FakeHost(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    return host;
}

let ipCounter = 0;
/** A paired host (the signed-in user must be an owner/admin: call actAs first). */
export async function pairHost(): Promise<{ hostId: string; token: string }> {
    const hosts = await import("@/app/api/runtime-hosts/route");
    const pair = await import("@/app/api/runtime-hosts/pair/route");
    const created = await hosts.POST();
    assert.equal(created.status, 201);
    const { code } = await created.json() as { code: string };
    const res = await pair.POST(makeRequest("http://localhost/api/runtime-hosts/pair", {
        method: "POST", headers: { "x-real-ip": `203.0.113.${++ipCounter % 250}` },
        body: { code, hostFingerprint: FP, hostname: "malecu-hermes-1", os: "Ubuntu 24.04", arch: "x86_64" },
    }));
    assert.equal(res.status, 201);
    const json = await res.json() as { hostId: string; hostToken: string };
    return { hostId: json.hostId, token: json.hostToken };
}

export function inventoryFrame(profiles: Frame[], extra: Frame = {}): Frame {
    return {
        type: "inventory",
        resources: { cpus: 8, memTotalMiB: 32000, memAvailMiB: 20000, diskFreeMiB: 90000, load1: 0.5 },
        capabilities: { browser: false, linger: true, systemdUser: true },
        llmProviders: ["deepseek", "openrouter"],
        profiles,
        ...extra,
    };
}

export async function jobRow(jobId: string) {
    const db = await getDb();
    const { runtimeHostJobs } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(runtimeHostJobs).where(eq(runtimeHostJobs.id, jobId));
    return row;
}

export async function waitForJob(jobId: string, status: string, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) {
        const row = await jobRow(jobId);
        if (row?.status === status) return row;
        if (Date.now() > end) throw new Error(`job ${jobId} is ${row?.status}, expected ${status}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}

export async function waitForHostStatus(hostId: string, status: string, ms = 5000) {
    const db = await getDb();
    const { runtimeHosts } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const end = Date.now() + ms;
    for (;;) {
        const [row] = await db.select().from(runtimeHosts).where(eq(runtimeHosts.id, hostId));
        if (row?.status === status) return row;
        if (Date.now() > end) throw new Error(`host ${hostId} is ${row?.status}, expected ${status}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}
