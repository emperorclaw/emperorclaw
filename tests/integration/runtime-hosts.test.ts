import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, seedHuman } from "./_access-helper";

/**
 * Runtime hosts (0.21): pairing, the host token's boundaries, and a fake host
 * daemon over a real websocket (lib/runtime-hosts/socket-server.ts mounted on
 * a plain http server, with a LISTEN host_jobs client standing in for
 * server.ts's listener) against a real Postgres.
 */
const maybe = dbAvailable ? test : test.skip;
const FP = "f".repeat(64);
const OTHER_FP = "e".repeat(64);

type Frame = Record<string, any>;

async function routes() {
    return {
        hosts: await import("@/app/api/runtime-hosts/route"),
        pair: await import("@/app/api/runtime-hosts/pair/route"),
        host: await import("@/app/api/runtime-hosts/[id]/route"),
        jobs: await import("@/app/api/runtime-hosts/[id]/jobs/route"),
        job: await import("@/app/api/runtime-host-jobs/[id]/route"),
    };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function world() {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const admin = await seedHuman(companyId, "admin");
    const member = await seedHuman(companyId, "member");
    const viktor = await seedAgent(companyId, { name: "Viktor", provider: "hermes" });
    const builder = await seedAgent(companyId, { name: "Builder", provider: "hermes" });
    const other = await seedCompanyWithToken();
    const foreign = await seedAgent(other.companyId, { name: "Foreign", provider: "hermes" });
    return { companyId, admin, member, viktor, builder, otherCompanyId: other.companyId, foreign };
}

async function newCode(): Promise<string> {
    const r = await routes();
    const res = await r.hosts.POST();
    assert.equal(res.status, 201);
    return (await res.json()).code;
}

let ipCounter = 0;
async function pair(code: string, fingerprint = FP, ip = `198.51.100.${++ipCounter % 250}`) {
    const r = await routes();
    const res = await r.pair.POST(makeRequest("http://localhost/api/runtime-hosts/pair", {
        method: "POST", headers: { "x-real-ip": ip },
        body: { code, hostFingerprint: fingerprint, hostname: "malecu-hermes-1", os: "Ubuntu 24.04", arch: "x86_64" },
    }));
    return { status: res.status, json: await res.json() };
}

// ── a fake host daemon ──────────────────────────────────────────────────────

class FakeHost {
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
    hello(jobs: Frame[] = [], fingerprint = FP) {
        this.send({ type: "hello", protocol: 1, hostdVersion: "0.21.0", installerVersion: "0.21.0", bridgeVersion: "0.21.0", hermesVersion: "v0.22.4",
            hostFingerprint: fingerprint, hostname: "malecu-hermes-1", os: "Ubuntu 24.04", arch: "x86_64", jobs });
    }
}

type Harness = { url: string; server: Server; close: () => Promise<void>; hostServer: import("@/lib/runtime-hosts/socket-server").HostSocketServer };

async function harness(clientIp = `harness-${randomUUID()}`): Promise<Harness> {
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
            // Let the closed sockets record their disconnect before the next test truncates.
            await new Promise((resolve) => setTimeout(resolve, 300));
            await listener.end();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

async function connect(h: Harness, token: string): Promise<FakeHost> {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(h.url, { headers: { Authorization: `Bearer ${token}` } });
    const host = new FakeHost(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    return host;
}

async function upgradeStatus(h: Harness, token: string): Promise<number> {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(h.url, { headers: { Authorization: `Bearer ${token}` } });
    return new Promise((resolve) => {
        ws.once("unexpected-response", (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
        ws.once("open", () => { resolve(101); ws.close(); });
        ws.once("error", () => resolve(0));
    });
}

async function jobRow(jobId: string) {
    const db = await getDb();
    const { runtimeHostJobs } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(runtimeHostJobs).where(eq(runtimeHostJobs.id, jobId));
    return row;
}

async function waitForJob(jobId: string, status: string, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) {
        const row = await jobRow(jobId);
        if (row?.status === status) return row;
        if (Date.now() > end) throw new Error(`job ${jobId} is ${row?.status}, expected ${status}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}

async function queueRestart(hostId: string, agentId: string, extra: Record<string, unknown> = {}) {
    const r = await routes();
    const res = await r.jobs.POST(makeRequest(`http://localhost/api/runtime-hosts/${hostId}/jobs`, {
        method: "POST", body: { command: "restart_agent", agentId, ...extra },
    }), params(hostId));
    return { status: res.status, json: await res.json() };
}

function inventory(s: Awaited<ReturnType<typeof world>>, extra: Frame[] = []) {
    return {
        type: "inventory",
        resources: { cpus: 8, memTotalMiB: 32000, memAvailMiB: 20000, diskFreeMiB: 90000, load1: 0.5 },
        capabilities: { browser: true, linger: true, systemdUser: true },
        llmProviders: ["deepseek"],
        profiles: [
            { profile: "viktor", agentId: s.viktor.id, sameEmperor: true, topology: "standalone", status: "active", gateway: "active", bridge: "active", health: { registered: true } },
            { profile: "foreign", agentId: s.foreign.id, sameEmperor: true, topology: "standalone", status: "active" },
            { profile: "growth", agentId: s.builder.id, sameEmperor: true, topology: "standalone", status: "legacy", legacy: true },
            ...extra,
        ],
    };
}

async function pairedHost(s: Awaited<ReturnType<typeof world>>) {
    actAs(s.admin);
    const code = await newCode();
    const { status, json } = await pair(code);
    assert.equal(status, 201);
    return { hostId: json.hostId as string, token: json.hostToken as string };
}

// ── pairing ─────────────────────────────────────────────────────────────────

maybe("pairing: a code works once, expires, is rate limited, and the token is not a company token", async () => {
    const s = await world();
    actAs(s.admin);
    const code = await newCode();
    assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const first = await pair(code.toLowerCase());
    assert.equal(first.status, 201);
    assert.match(first.json.hostToken, /^ech_[0-9a-f]{64}$/);
    const again = await pair(code);
    assert.equal(again.status, 400, "a used code is refused");

    const db = await getDb();
    const { runtimeHostPairings, runtimeHosts, companyTokens, auditLog } = await getSchema();
    const { eq, sql } = await import("drizzle-orm");
    const expiring = await newCode();
    await db.update(runtimeHostPairings).set({ expiresAt: sql`now() - interval '1 minute'` }).where(sql`${runtimeHostPairings.usedAt} IS NULL`);
    assert.equal((await pair(expiring)).status, 400, "an expired code is refused");
    assert.equal((await pair("ZZZZ-ZZZZ")).status, 400);

    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await pair("AAAA-AAAA", FP, ip)).status);
    assert.equal(statuses.at(-1), 429, "the 11th attempt from one address in 10 minutes is refused");

    const [host] = await db.select().from(runtimeHosts).where(eq(runtimeHosts.id, first.json.hostId));
    assert.notEqual(host.tokenHash, first.json.hostToken, "only the hash is stored");
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(first.json.hostToken).digest("hex");
    assert.equal(host.tokenHash, hash);
    assert.equal((await db.select().from(companyTokens).where(eq(companyTokens.tokenHash, hash))).length, 0, "never in company_tokens");
    const audit = await db.select().from(auditLog).where(eq(auditLog.companyId, s.companyId));
    assert.ok(audit.some((a) => a.action === "runtime_host.paired" && a.targetId === host.id));
    assert.ok(audit.some((a) => a.action === "company.host_pairing_created"));

    // Re-pairing the same machine revokes the previous host row.
    const second = await pair(await newCode());
    assert.equal(second.status, 201);
    const [old] = await db.select().from(runtimeHosts).where(eq(runtimeHosts.id, first.json.hostId));
    assert.ok(old.revokedAt, "the earlier host of this fingerprint is revoked");
});

maybe("access: members get 403 on every runtime host route", async () => {
    const s = await world();
    const { hostId } = await pairedHost(s);
    const r = await routes();
    actAs(s.member);
    assert.equal((await r.hosts.GET()).status, 403);
    assert.equal((await r.hosts.POST()).status, 403);
    assert.equal((await r.host.GET(makeRequest(`http://localhost/api/runtime-hosts/${hostId}`), params(hostId))).status, 403);
    assert.equal((await r.host.DELETE(makeRequest(`http://localhost/api/runtime-hosts/${hostId}`, { method: "DELETE" }), params(hostId))).status, 403);
    assert.equal((await queueRestart(hostId, s.viktor.id)).status, 403);
    actAs(null);
    assert.equal((await r.hosts.GET()).status, 401);
});

// ── the host token never works on MCP ───────────────────────────────────────

function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) out.push(...routeFiles(full));
        else if (name === "route.ts") out.push(full);
    }
    return out;
}

maybe("host token: every /api/mcp/* route and /mcp treat it like no token; /api/mcp/ws refuses it", async () => {
    const s = await world();
    const { token } = await pairedHost(s);
    const files = [...routeFiles(path.join(process.cwd(), "src/app/api/mcp")), path.join(process.cwd(), "src/app/mcp/route.ts")];
    assert.ok(files.length > 50);
    let unauthorized = 0;
    let checked = 0;
    for (const file of files) {
        const mod = await import(pathToFileURL(file).href) as Record<string, unknown>;
        for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
            const handler = mod[method];
            if (typeof handler !== "function") continue;
            const url = `http://localhost/${path.relative(path.join(process.cwd(), "src/app"), path.dirname(file)).replace(/\\/g, "/")}`;
            const call = async (headers: Record<string, string>) => {
                const req = makeRequest(url, { method, headers: { "x-real-ip": "192.0.2.10", ...headers }, ...(method === "GET" ? {} : { body: {} }) });
                const ctx = { params: Promise.resolve(new Proxy({}, { get: () => randomUUID() })) };
                try {
                    return (await (handler as (r: unknown, c: unknown) => Promise<Response>)(req, ctx)).status;
                } catch {
                    return -1;
                }
            };
            const anonymous = await call({});
            const withHostToken = await call({ authorization: `Bearer ${token}` });
            checked++;
            assert.equal(withHostToken, anonymous, `${method} ${url}: the host token must grant nothing (anonymous ${anonymous}, host token ${withHostToken})`);
            assert.ok(withHostToken < 200 || withHostToken >= 300 || anonymous === withHostToken, `${method} ${url} succeeded with a host token`);
            if (withHostToken === 401) unauthorized++;
        }
    }
    assert.ok(unauthorized >= checked * 0.9, `most MCP handlers answer 401 (${unauthorized}/${checked})`);
    // /api/mcp/ws: server.ts authenticates the upgrade with exactly this function.
    const { verifyMcpAuthorizationHeader } = await import("@/lib/mcp");
    const auth = await verifyMcpAuthorizationHeader(`Bearer ${token}`);
    assert.equal(auth.status, 401);
    assert.equal(auth.companyToken, undefined);
});

// ── a fake host over the socket ─────────────────────────────────────────────

maybe("socket: hello, welcome, inventory adoption (cross-company refused), restart with progress and result", async () => {
    const s = await world();
    const { hostId, token } = await pairedHost(s);
    const h = await harness();
    try {
        assert.equal(await upgradeStatus(h, `ech_${"0".repeat(64)}`), 401, "an unknown host token is refused at the upgrade");
        const host = await connect(h, token);
        host.hello();
        const welcome = await host.waitFor(() => host.frames.find((f) => f.type === "welcome"));
        assert.equal(welcome.hostId, hostId);
        assert.equal(welcome.heartbeatSec, 30);
        assert.equal(welcome.bridge.latest, "0.21.0");
        host.send(inventory(s));
        host.send({ type: "heartbeat", memAvailMiB: 19000, load1: 0.3, activeJobId: null });

        const db = await getDb();
        const { agents, runtimeHosts, runtimeHostJobEvents, auditLog } = await getSchema();
        const { eq } = await import("drizzle-orm");
        const end = Date.now() + 5000;
        let viktor;
        do {
            [viktor] = await db.select().from(agents).where(eq(agents.id, s.viktor.id));
            if (viktor.runtimeHostId) break;
            await new Promise((r) => setTimeout(r, 50));
        } while (Date.now() < end);
        assert.equal(viktor!.runtimeHostId, hostId, "Viktor is adopted");
        assert.equal(viktor!.runtimeProfile, "viktor");
        const [foreign] = await db.select().from(agents).where(eq(agents.id, s.foreign.id));
        assert.equal(foreign.runtimeHostId, null, "another company's agent is never adopted");
        const [builder] = await db.select().from(agents).where(eq(agents.id, s.builder.id));
        assert.equal(builder.runtimeHostId, null, "a legacy 0.3 profile is not adopted");
        const [row] = await db.select().from(runtimeHosts).where(eq(runtimeHosts.id, hostId));
        assert.equal(row.status, "online");
        assert.equal(row.bridgeVersion, "0.21.0");
        assert.deepEqual((row.inventoryJson as any).conflicts.map((c: any) => c.reason), ["unknown_agent"]);

        const r = await routes();
        actAs(s.admin);
        const list = await (await r.hosts.GET()).json();
        assert.equal(list.hosts[0].agents[0].name, "Viktor");
        assert.equal(list.hosts[0].capabilities.browser, true);
        assert.deepEqual(list.hosts[0].llmProviders, ["deepseek"]);
        assert.equal(list.hosts[0].resources.memAvailMiB, 19000, "the heartbeat's free memory wins");
        assert.ok(!JSON.stringify(list).includes(row.tokenHash), "the token hash is never served");

        // Refused before anything is queued.
        for (const command of ["provision_agent", "update_runtime", "remove_agent", "rotate_agent_token", "rm -rf"]) {
            const res = await r.jobs.POST(makeRequest(`http://localhost/api/runtime-hosts/${hostId}/jobs`, { method: "POST", body: { command, agentId: s.viktor.id } }), params(hostId));
            assert.equal(res.status, 400, `${command} is refused in 0.21`);
        }
        assert.equal((await queueRestart(hostId, s.builder.id)).status, 400, "an agent not on this host cannot be restarted through it");

        const queued = await queueRestart(hostId, s.viktor.id, { idempotencyKey: "restart-key-1" });
        assert.equal(queued.status, 201);
        const jobId = queued.json.job.id;
        const command = await host.waitFor(() => host.commands().find((f) => f.jobId === jobId));
        assert.equal(command.command, "restart_agent");
        assert.deepEqual(command.args, { profile: "viktor", target: "bridge" }, "no topology or idle policy from the server");
        assert.equal(command.deadlineSec, 420);
        const repeat = await queueRestart(hostId, s.viktor.id, { idempotencyKey: "restart-key-1" });
        assert.equal(repeat.status, 200);
        assert.equal(repeat.json.job.id, jobId, "the same idempotency key returns the same job");
        const conflict = await queueRestart(hostId, s.viktor.id, { idempotencyKey: "restart-key-1", target: "gateway" });
        assert.equal(conflict.status, 409, "the key reused for a different command is a conflict");

        host.send({ type: "ack", jobId, accepted: true });
        host.send({ type: "progress", jobId, seq: 1, step: "Restarting emperor-hermes-bridge@viktor", line: "==> Restarting emperor-hermes-bridge@viktor" });
        host.send({ type: "progress", jobId, seq: 2, line: `token ech_${"9".repeat(64)} sk-secretsecret123` });
        host.send({ type: "progress", jobId, seq: 2, line: "duplicate seq is ignored" });
        host.send({ type: "result", jobId, ok: true, exitCode: 0, summary: "restart bridge of viktor: done", logTail: "ok", units: ["emperor-hermes-bridge@viktor.service"] });
        const done = await waitForJob(jobId, "succeeded");
        assert.equal((done.resultJson as any).exitCode, 0);
        assert.deepEqual((done.resultJson as any).units, ["emperor-hermes-bridge@viktor.service"]);
        // A duplicate result changes nothing.
        host.send({ type: "result", jobId, ok: false, exitCode: 1, summary: "late" });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal((await jobRow(jobId)).status, "succeeded");

        const events = await db.select().from(runtimeHostJobEvents).where(eq(runtimeHostJobEvents.jobId, jobId));
        assert.equal(events.length, 2);
        assert.ok(!events.some((e) => (e.line ?? "").includes("9".repeat(64)) || (e.line ?? "").includes("sk-secretsecret123")), "secrets in progress lines are redacted");
        const polled = await (await r.job.GET(makeRequest(`http://localhost/api/runtime-host-jobs/${jobId}?afterSeq=1`), params(jobId))).json();
        assert.equal(polled.job.status, "succeeded");
        assert.deepEqual(polled.events.map((e: any) => e.seq), [2]);

        const audit = await db.select().from(auditLog).where(eq(auditLog.companyId, s.companyId));
        for (const action of ["runtime_host.connected", "runtime_host.job_queued", "runtime_host.job_finished", "agent.runtime_host_changed"]) {
            assert.ok(audit.some((a) => a.action === action), `audit has ${action}`);
        }
        assert.equal(audit.filter((a) => a.action === "runtime_host.job_finished").length, 1, "one finish, despite the duplicate result");
    } finally {
        await h.close();
    }
});

maybe("socket: one job at a time; busy requeues; offline queue runs on reconnect; a finished job is replayed, not rerun", async () => {
    const s = await world();
    const { hostId, token } = await pairedHost(s);
    const h = await harness();
    try {
        let host = await connect(h, token);
        host.hello();
        await host.waitFor(() => host.frames.find((f) => f.type === "welcome"));
        host.send(inventory(s));
        const db = await getDb();
        const { agents, runtimeHosts } = await getSchema();
        const { eq } = await import("drizzle-orm");
        for (let i = 0; i < 100; i++) {
            const [a] = await db.select().from(agents).where(eq(agents.id, s.viktor.id));
            if (a.runtimeHostId) break;
            await new Promise((r) => setTimeout(r, 50));
        }
        actAs(s.admin);
        const first = (await queueRestart(hostId, s.viktor.id)).json.job.id;
        const second = (await queueRestart(hostId, s.viktor.id, { target: "gateway" })).json.job.id;
        await host.waitFor(() => host.commands().find((f) => f.jobId === first));
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(!host.commands().some((f) => f.jobId === second), "the second job waits while the first runs");
        // The host says busy (another job of its own runs): back to the queue.
        host.send({ type: "ack", jobId: first, accepted: false, reason: "busy" });
        await waitForJob(first, "queued");

        // The host goes away; jobs stay queued.
        host.ws.close();
        for (let i = 0; i < 100; i++) {
            const [row] = await db.select().from(runtimeHosts).where(eq(runtimeHosts.id, hostId));
            if (row.status === "offline") break;
            await new Promise((r) => setTimeout(r, 50));
        }
        const [offline] = await db.select().from(runtimeHosts).where(eq(runtimeHosts.id, hostId));
        assert.equal(offline.status, "offline");

        // Reconnect: the queue drains in order, one at a time.
        host = await connect(h, token);
        host.hello();
        const cmd1 = await host.waitFor(() => host.commands().find((f) => f.jobId === first));
        assert.equal(cmd1.command, "restart_agent");
        host.send({ type: "ack", jobId: first, accepted: true });
        // The connection drops before the result; the host finished the job meanwhile.
        await waitForJob(first, "running");
        host.ws.close();
        await new Promise((r) => setTimeout(r, 200));
        host = await connect(h, token);
        host.hello([{ jobId: first, state: "done", lastSeq: 0 }]);
        const replay = await host.waitFor(() => host.commands().find((f) => f.jobId === first));
        assert.ok(replay, "a job the host finished is sent again so it replays the stored result");
        host.send({ type: "ack", jobId: first, accepted: true });
        host.send({ type: "result", jobId: first, ok: true, exitCode: 0, summary: "replayed" });
        await waitForJob(first, "succeeded");
        const cmd2 = await host.waitFor(() => host.commands().find((f) => f.jobId === second));
        assert.deepEqual(cmd2.args, { profile: "viktor", target: "gateway" });
        host.send({ type: "ack", jobId: second, accepted: false, reason: "invalid_args: nope" });
        const failed = await waitForJob(second, "failed");
        assert.match(failed.error ?? "", /invalid_args/);

        // A job the host never heard of after a reconnect goes back to the queue.
        const third = (await queueRestart(hostId, s.viktor.id)).json.job.id;
        await host.waitFor(() => host.commands().find((f) => f.jobId === third));
        host.ws.close();
        await new Promise((r) => setTimeout(r, 200));
        host = await connect(h, token);
        host.hello([]);
        await host.waitFor(() => host.commands().find((f) => f.jobId === third));
        assert.equal((await jobRow(third)).attempts, 2);
    } finally {
        await h.close();
    }
});

maybe("shared gateway safety: with no or stale topology the server sends no idle policy; force only when the admin chose it", async () => {
    const s = await world();
    const { hostId, token } = await pairedHost(s);
    const db = await getDb();
    const { agents, runtimeHosts } = await getSchema();
    const { eq } = await import("drizzle-orm");
    // The host never sent an inventory (null topology), or an old one claims standalone.
    await db.update(agents).set({ runtimeHostId: hostId, runtimeProfile: "qa" }).where(eq(agents.id, s.viktor.id));
    const h = await harness();
    try {
        const host = await connect(h, token);
        host.hello();
        await host.waitFor(() => host.frames.find((f) => f.type === "welcome"));
        actAs(s.admin);
        for (const inventory of [{}, { profiles: [{ profile: "qa", agentId: s.viktor.id, topology: "standalone" }] }]) {
            await db.update(runtimeHosts).set({ inventoryJson: inventory }).where(eq(runtimeHosts.id, hostId));
            const { json } = await queueRestart(hostId, s.viktor.id, { target: "gateway" });
            const cmd = await host.waitFor(() => host.commands().find((f) => f.jobId === json.job.id));
            assert.deepEqual(cmd.args, { profile: "qa", target: "gateway" }, "the daemon's record decides; absent force = wait for idle");
            host.send({ type: "result", jobId: json.job.id, ok: true, exitCode: 0, summary: "ok" });
            await waitForJob(json.job.id, "succeeded");
        }
        const forced = await queueRestart(hostId, s.viktor.id, { target: "gateway", force: true });
        const cmd = await host.waitFor(() => host.commands().find((f) => f.jobId === forced.json.job.id));
        assert.deepEqual(cmd.args, { profile: "qa", target: "gateway", force: true });
        assert.equal((await queueRestart(hostId, s.viktor.id, { target: "gateway", force: false })).status, 400, "force is true or absent");
        assert.equal((await queueRestart(hostId, s.viktor.id, { target: "gateway", whenIdle: false })).status, 400, "the server takes no idle policy");
    } finally {
        await h.close();
    }
});

maybe("limits: frame floods and oversized frames close the socket; upgrades are rate limited per IP; progress is capped", async () => {
    const s = await world();
    const { hostId, token } = await pairedHost(s);
    const h = await harness();
    try {
        const flood = await connect(h, token);
        flood.hello();
        await flood.waitFor(() => flood.frames.find((f) => f.type === "welcome"));
        for (let i = 0; i < 150; i++) flood.send({ type: "heartbeat", memAvailMiB: 1, load1: 0, activeJobId: null });
        assert.equal((await flood.waitFor(() => flood.closed)).code, 4429);

        const big = await connect(h, token);
        big.hello();
        await big.waitFor(() => big.frames.find((f) => f.type === "welcome"));
        big.ws.send(JSON.stringify({ type: "heartbeat", memAvailMiB: 1, load1: 0, activeJobId: null }) + " ".repeat(40_000));
        assert.equal((await big.waitFor(() => big.closed)).code, 4400, "only an inventory may be large");

        // Progress beyond the per-job cap is dropped and the job marked truncated.
        const db = await getDb();
        const { agents, runtimeHostJobEvents } = await getSchema();
        const { eq } = await import("drizzle-orm");
        await db.update(agents).set({ runtimeHostId: hostId, runtimeProfile: "viktor" }).where(eq(agents.id, s.viktor.id));
        const host = await connect(h, token);
        host.hello();
        await host.waitFor(() => host.frames.find((f) => f.type === "welcome"));
        actAs(s.admin);
        const jobId = (await queueRestart(hostId, s.viktor.id)).json.job.id;
        await host.waitFor(() => host.commands().find((f) => f.jobId === jobId));
        host.send({ type: "ack", jobId, accepted: true });
        host.send({ type: "progress", jobId, seq: 2000, line: "last kept" });
        host.send({ type: "progress", jobId, seq: 2001, line: "dropped" });
        for (let i = 0; i < 100; i++) {
            if ((await jobRow(jobId)).progressTruncated) break;
            await new Promise((r) => setTimeout(r, 30));
        }
        assert.equal((await jobRow(jobId)).progressTruncated, true);
        const events = await db.select().from(runtimeHostJobEvents).where(eq(runtimeHostJobEvents.jobId, jobId));
        assert.deepEqual(events.map((e) => e.seq), [2000]);
    } finally {
        await h.close();
    }
    const limited = await harness("203.0.113.200");
    try {
        const statuses: number[] = [];
        for (let i = 0; i < 31; i++) statuses.push(await upgradeStatus(limited, `ech_${"0".repeat(64)}`));
        assert.equal(statuses[0], 401);
        assert.equal(statuses[30], 429, "the 31st upgrade from one IP in a minute is refused");
    } finally {
        await limited.close();
    }
});

maybe("revocation never depends on NOTIFY alone; a deleted company's host token stops working", async () => {
    const s = await world();
    const { hostId, token } = await pairedHost(s);
    const h = await harness();
    try {
        const host = await connect(h, token);
        host.hello();
        await host.waitFor(() => host.frames.find((f) => f.type === "welcome"));
        const db = await getDb();
        const { runtimeHosts, companies } = await getSchema();
        const { eq, sql } = await import("drizzle-orm");
        // Revoked behind the server's back: no pg_notify.
        await db.update(runtimeHosts).set({ revokedAt: sql`now()`, status: "revoked" }).where(eq(runtimeHosts.id, hostId));
        await h.hostServer.sweep();
        assert.equal((await host.waitFor(() => host.closed)).code, 4401, "the sweep tick closes a revoked host's socket");

        // A heartbeat from a host revoked meanwhile is refused too.
        await db.update(runtimeHosts).set({ revokedAt: null, status: "offline" }).where(eq(runtimeHosts.id, hostId));
        const again = await connect(h, token);
        again.hello();
        await again.waitFor(() => again.frames.find((f) => f.type === "welcome"));
        await db.update(runtimeHosts).set({ revokedAt: sql`now()` }).where(eq(runtimeHosts.id, hostId));
        again.send({ type: "heartbeat", memAvailMiB: 1, load1: 0, activeJobId: null });
        assert.equal((await again.waitFor(() => again.closed)).code, 4401);

        await db.update(runtimeHosts).set({ revokedAt: null }).where(eq(runtimeHosts.id, hostId));
        assert.equal(await upgradeStatus(h, token), 101);
        await db.update(companies).set({ deletedAt: sql`now()` }).where(eq(companies.id, s.companyId));
        assert.equal(await upgradeStatus(h, token), 401, "a deleted company's host cannot connect");
    } finally {
        await h.close();
    }
});

maybe("two daemons on one token: repeated replacements flag the host; offline reasons are recorded", async () => {
    const s = await world();
    const { hostId, token } = await pairedHost(s);
    const h = await harness();
    try {
        const sockets: FakeHost[] = [];
        const db = await getDb();
        const { runtimeHosts } = await getSchema();
        const { eq } = await import("drizzle-orm");
        for (let i = 0; i < 4; i++) {
            const next = await connect(h, token);
            next.hello();
            await next.waitFor(() => next.frames.find((f) => f.type === "welcome"));
            if (sockets.length > 0) await sockets[sockets.length - 1].waitFor(() => sockets[sockets.length - 1].closed);
            sockets.push(next);
            if (i === 2) {
                // Two replacements (each reached by the hello handler AND the NOTIFY): counted once each, no flag yet.
                await new Promise((r) => setTimeout(r, 300));
                const [early] = await db.select().from(runtimeHosts).where(eq(runtimeHosts.id, hostId));
                assert.equal(early.duplicateDaemonAt, null, "a replaced socket is counted once");
            }
        }
        let row;
        for (let i = 0; i < 100; i++) {
            [row] = await db.select().from(runtimeHosts).where(eq(runtimeHosts.id, hostId));
            if (row.duplicateDaemonAt) break;
            await new Promise((r) => setTimeout(r, 30));
        }
        assert.ok(row!.duplicateDaemonAt, "three replacements of a live socket mark a duplicate daemon");
        actAs(s.admin);
        const r = await routes();
        const list = await (await r.hosts.GET()).json();
        assert.equal(list.hosts[0].duplicateDaemon, true);

        sockets[3].ws.close();
        for (let i = 0; i < 100; i++) {
            [row] = await db.select().from(runtimeHosts).where(eq(runtimeHosts.id, hostId));
            if (row.status === "offline") break;
            await new Promise((r2) => setTimeout(r2, 30));
        }
        assert.equal(row!.offlineReason, "disconnected");
        const after = await (await r.hosts.GET()).json();
        assert.equal(after.hosts[0].offlineReason, "disconnected");
    } finally {
        await h.close();
    }
});

maybe("socket: a newer connection replaces the old (4409); a wrong machine gets 4403, revocation 4401", async () => {
    const s = await world();
    const { hostId, token } = await pairedHost(s);
    const h = await harness();
    try {
        const a = await connect(h, token);
        a.hello();
        await a.waitFor(() => a.frames.find((f) => f.type === "welcome"));
        const b = await connect(h, token);
        b.hello();
        await b.waitFor(() => b.frames.find((f) => f.type === "welcome"));
        const replaced = await a.waitFor(() => a.closed);
        assert.equal(replaced.code, 4409);

        const thief = await connect(h, token);
        thief.hello([], OTHER_FP);
        assert.equal((await thief.waitFor(() => thief.closed)).code, 4403, "another machine's fingerprint: refused (retryable, not a revocation)");

        b.send(inventory(s));
        const db = await getDb();
        const { agents, auditLog } = await getSchema();
        const { eq } = await import("drizzle-orm");
        for (let i = 0; i < 100; i++) {
            const [v] = await db.select().from(agents).where(eq(agents.id, s.viktor.id));
            if (v.runtimeHostId) break;
            await new Promise((r) => setTimeout(r, 50));
        }
        actAs(s.admin);
        const r = await routes();
        const res = await r.host.DELETE(makeRequest(`http://localhost/api/runtime-hosts/${hostId}`, { method: "DELETE" }), params(hostId));
        assert.equal(res.status, 200);
        assert.equal((await res.json()).host.status, "revoked");
        assert.equal((await b.waitFor(() => b.closed)).code, 4401, "revoking closes the live socket");
        assert.equal(await upgradeStatus(h, token), 401, "a revoked token cannot reconnect");
        const [v] = await db.select().from(agents).where(eq(agents.id, s.viktor.id));
        assert.equal(v.runtimeHostId, null, "its agents are released");
        const audit = await db.select().from(auditLog).where(eq(auditLog.companyId, s.companyId));
        assert.ok(audit.some((x) => x.action === "runtime_host.revoked" && x.targetId === hostId && x.actorId === s.admin.userId));
    } finally {
        await h.close();
    }
});

maybe("sweeper: silent hosts go offline, unacknowledged jobs requeue then fail, overdue jobs time out", async () => {
    const s = await world();
    const { hostId } = await pairedHost(s);
    const db = await getDb();
    const { runtimeHosts, runtimeHostJobs } = await getSchema();
    const { eq, sql } = await import("drizzle-orm");
    await db.update(runtimeHosts).set({ status: "online", lastSeenAt: sql`now() - interval '5 minutes'` }).where(eq(runtimeHosts.id, hostId));
    const [noAck] = await db.insert(runtimeHostJobs).values({ companyId: s.companyId, hostId, command: "refresh_inventory", status: "sent", attempts: 1, sentAt: sql`now() - interval '1 minute'` }).returning();
    const [lastTry] = await db.insert(runtimeHostJobs).values({ companyId: s.companyId, hostId, command: "refresh_inventory", status: "sent", attempts: 3, sentAt: sql`now() - interval '1 minute'` }).returning();
    const [overdue] = await db.insert(runtimeHostJobs).values({ companyId: s.companyId, hostId, command: "restart_agent", status: "running", attempts: 1, deadlineAt: sql`now() - interval '2 minutes'` }).returning();
    const { runtimeHostJobEvents } = await getSchema();
    const [ancient] = await db.insert(runtimeHostJobs).values({ companyId: s.companyId, hostId, command: "refresh_inventory", status: "succeeded", finishedAt: sql`now() - interval '91 days'` }).returning();
    const [recent] = await db.insert(runtimeHostJobs).values({ companyId: s.companyId, hostId, command: "refresh_inventory", status: "succeeded", finishedAt: sql`now() - interval '1 day'` }).returning();
    await db.insert(runtimeHostJobEvents).values([
        { jobId: recent.id, seq: 1, line: "old", at: sql`now() - interval '31 days'` },
        { jobId: recent.id, seq: 2, line: "new" },
    ]);
    const { sweepRuntimeHosts } = await import("@/lib/runtime-hosts/store");
    const result = await sweepRuntimeHosts();
    assert.ok(result);
    const [host] = await db.select().from(runtimeHosts).where(eq(runtimeHosts.id, hostId));
    assert.equal(host.status, "offline");
    assert.equal((await jobRow(noAck.id)).status, "queued");
    assert.equal((await jobRow(lastTry.id)).status, "failed");
    assert.equal((await jobRow(overdue.id)).status, "timed_out");
    assert.equal(host.offlineReason, "silent");
    assert.equal(await jobRow(ancient.id), undefined, "finished jobs older than 90 days are pruned");
    assert.ok(await jobRow(recent.id));
    const kept = await db.select().from(runtimeHostJobEvents).where(eq(runtimeHostJobEvents.jobId, recent.id));
    assert.deepEqual(kept.map((e) => e.line), ["new"], "progress lines older than 30 days are pruned");
});
