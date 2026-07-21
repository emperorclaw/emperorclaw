import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { requirePlatformAdminSession } from "@/lib/platform-admin";
import fs from "fs";
import http from "http";

export const dynamic = "force-dynamic";
const execAsync = promisify(exec);

// Bare-metal self-update runs git/npm/pm2 here. Default to the directory the
// app is actually running from (the repo root, wherever it was cloned — the
// installer uses $HOME/emperorclaw); override with EMPEROR_UPDATE_DIR if needed.
const PROJECT_DIR = process.env.EMPEROR_UPDATE_DIR || process.cwd();
const GITHUB_RELEASES_API = "https://api.github.com/repos/emperorclaw/emperorclaw/releases/latest";
const DOCKER_SOCKET = "/var/run/docker.sock";
const IMAGE = "ghcr.io/emperorclaw/emperorclaw:latest";

function isDocker(): boolean {
    try { return fs.existsSync("/.dockerenv"); } catch { return false; }
}

type UpdateStep = {
    step: string;
    status: "running" | "ok" | "error";
    output: string;
};

// ---- Docker Engine API over Unix socket ----

function dockerCall(method: string, path: string, body?: unknown): Promise<{ code: number; data: unknown }> {
    return new Promise((resolve, reject) => {
        const opts: http.RequestOptions = {
            socketPath: DOCKER_SOCKET,
            method,
            path,
            headers: { "Content-Type": "application/json" },
            timeout: method === "POST" && path.includes("/images/create") ? 300_000 : 30_000,
        };
        if (method === "POST" && path.includes("/images/create")) {
            (opts as Record<string, unknown>).agent = false;
        }
        const req = http.request(opts, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf-8");
                try { resolve({ code: res.statusCode ?? 500, data: JSON.parse(raw) }); }
                catch { resolve({ code: res.statusCode ?? 500, data: raw }); }
            });
            res.on("error", reject);
        });
        req.on("error", reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
    });
}

async function dockerPull(): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            socketPath: DOCKER_SOCKET,
            method: "POST",
            path: `/images/create?fromImage=${encodeURIComponent(IMAGE)}`,
            timeout: 300_000,
            agent: false,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`Pull failed: HTTP ${res.statusCode}`));
                }
                const lines = Buffer.concat(chunks).toString("utf-8").trim().split("\n");
                const last = JSON.parse(lines[lines.length - 1] || "{}");
                resolve(last.status || last.error || "Image pulled");
            });
            res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
    });
}

async function getOwnContainerId(): Promise<string> {
    try {
        const cgroup = fs.readFileSync("/proc/self/cgroup", "utf-8");
        const match = cgroup.match(/[0-9a-f]{64}/);
        if (match) return match[0];
    } catch { /* fall through */ }
    try {
        const h = fs.readFileSync("/etc/hostname", "utf-8").trim();
        if (h.length === 12) return h;
    } catch { /* fall through */ }
    throw new Error("Cannot determine container ID");
}

// ---- Pre-update DB backup (Docker path) ----
// Migrations run on the new container's startup and are effectively
// irreversible, so we snapshot the database first via pg_dump inside the
// Postgres container (postgres:alpine ships pg_dump). The dump is written to
// the app's persistent storage volume so it survives the container swap.

type PgConn = { user: string; password: string; database: string };

function parsePgConn(): PgConn | null {
    const raw = process.env.POSTGRES_CONNECTION_STRING || process.env.DATABASE_URL || "";
    if (!raw) return null;
    try {
        const u = new URL(raw);
        const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
        return {
            user: decodeURIComponent(u.username) || "postgres",
            password: decodeURIComponent(u.password) || "",
            database,
        };
    } catch { return null; }
}

async function findPostgresContainer(): Promise<string | null> {
    const { code, data } = await dockerCall("GET", "/containers/json");
    if (code !== 200 || !Array.isArray(data)) return null;
    const match = (data as Array<Record<string, unknown>>).find(
        (c) => typeof c.Image === "string" && /postgres/i.test(c.Image as string),
    );
    return match ? (match.Id as string) : null;
}

/** Run a command in a container via the Docker exec API, streaming stdout to a file. */
function dockerExecToFile(containerId: string, cmd: string[], env: string[], filePath: string): Promise<{ exitCode: number; stderr: string; bytes: number }> {
    return new Promise((resolve, reject) => {
        dockerCall("POST", `/containers/${containerId}/exec`, {
            AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd, Env: env,
        }).then(({ code, data }) => {
            if (code !== 201) return reject(new Error(`exec create HTTP ${code}`));
            const execId = (data as { Id: string }).Id;
            const out = fs.createWriteStream(filePath);
            let stderr = "";
            let bytes = 0;
            let leftover = Buffer.alloc(0);

            const req = http.request({
                socketPath: DOCKER_SOCKET, method: "POST",
                path: `/exec/${execId}/start`,
                headers: { "Content-Type": "application/json" },
                timeout: 600_000, agent: false,
            }, (res) => {
                res.on("data", (chunk: Buffer) => {
                    // Demux Docker's multiplexed stream: [type(1)][000][size(4 BE)][payload]
                    let buf = Buffer.concat([leftover, chunk]);
                    while (buf.length >= 8) {
                        const size = buf.readUInt32BE(4);
                        if (buf.length < 8 + size) break;
                        const type = buf[0];
                        const payload = buf.subarray(8, 8 + size);
                        if (type === 2) stderr += payload.toString("utf-8").slice(0, 4000);
                        else { out.write(payload); bytes += payload.length; }
                        buf = buf.subarray(8 + size);
                    }
                    leftover = buf;
                });
                res.on("end", () => {
                    out.end(async () => {
                        try {
                            const { data: inspect } = await dockerCall("GET", `/exec/${execId}/json`);
                            const exitCode = ((inspect as { ExitCode?: number }).ExitCode) ?? 0;
                            resolve({ exitCode, stderr: stderr.trim(), bytes });
                        } catch (e) { reject(e); }
                    });
                });
                res.on("error", reject);
            });
            req.on("error", reject);
            req.end();
        }).catch(reject);
    });
}

/**
 * Best-effort-but-fail-closed DB backup before a Docker self-update.
 * Returns a step. If a Postgres container is found and the dump fails, the
 * caller MUST abort the update. If no Postgres container is found (external /
 * managed DB), the backup is skipped with a warning and the update continues.
 */
async function backupDatabaseViaDocker(): Promise<{ step: UpdateStep; fatal: boolean }> {
    const conn = parsePgConn();
    if (!conn) {
        return { step: { step: "backup-db", status: "ok", output: "Skipped: no POSTGRES_CONNECTION_STRING to back up." }, fatal: false };
    }
    let pgId: string | null;
    try {
        pgId = await findPostgresContainer();
    } catch (e) {
        return { step: { step: "backup-db", status: "error", output: `Could not list containers: ${(e as Error).message}` }, fatal: true };
    }
    if (!pgId) {
        return { step: { step: "backup-db", status: "ok", output: "Skipped: no Postgres container found (external DB — back up yourself before updating)." }, fatal: false };
    }

    const dir = process.env.STORAGE_LOCAL_DIR || "./.data/storage";
    const backupDir = `${dir.replace(/\/+$/, "")}/backups`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = `${backupDir}/pre-update-${stamp}.sql`;
    try {
        fs.mkdirSync(backupDir, { recursive: true });
        const { exitCode, stderr, bytes } = await dockerExecToFile(
            pgId,
            ["pg_dump", "-U", conn.user, "-d", conn.database, "--no-owner", "--clean", "--if-exists"],
            [`PGPASSWORD=${conn.password}`],
            filePath,
        );
        if (exitCode !== 0 || bytes === 0) {
            try { fs.unlinkSync(filePath); } catch { /* ignore */ }
            return { step: { step: "backup-db", status: "error", output: `pg_dump exit ${exitCode}${stderr ? `: ${stderr}` : ""} (${bytes} bytes)` }, fatal: true };
        }
        return { step: { step: "backup-db", status: "ok", output: `Backed up ${(bytes / 1024).toFixed(0)} KB → ${filePath}` }, fatal: false };
    } catch (e) {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        return { step: { step: "backup-db", status: "error", output: `Backup failed: ${(e as Error).message}` }, fatal: true };
    }
}

async function dockerUpdateSelf(): Promise<UpdateStep[]> {
    const steps: UpdateStep[] = [];

    // 1. Find own container
    let cid: string;
    try {
        cid = await getOwnContainerId();
        steps.push({ step: "find-container", status: "ok", output: cid.slice(0, 12) });
    } catch (e) {
        steps.push({ step: "find-container", status: "error", output: (e as Error).message });
        return steps;
    }

    // 2. Inspect current config
    let info: Record<string, unknown>;
    try {
        const { data } = await dockerCall("GET", `/containers/${cid}/json`);
        info = data as Record<string, unknown>;
        steps.push({ step: "inspect-container", status: "ok", output: "Config captured" });
    } catch (e) {
        steps.push({ step: "inspect-container", status: "error", output: (e as Error).message });
        return steps;
    }

    // 3. Back up the database (fail-closed: abort if a dump was possible but failed)
    const backup = await backupDatabaseViaDocker();
    steps.push(backup.step);
    if (backup.fatal) return steps;

    // 4. Pull latest image
    try {
        const msg = await dockerPull();
        steps.push({ step: "pull-image", status: "ok", output: msg });
    } catch (e) {
        steps.push({ step: "pull-image", status: "error", output: (e as Error).message });
        return steps;
    }

    // 4. Build replacement config from old container
    const hc = (info.HostConfig ?? {}) as Record<string, unknown>;
    const cfg = (info.Config ?? {}) as Record<string, unknown>;
    const ns = (info.NetworkSettings ?? {}) as Record<string, unknown>;
    const nets = (ns.Networks ?? {}) as Record<string, unknown>;
    const netNames = Object.keys(nets);

    const createBody = {
        Image: IMAGE,
        Env: cfg.Env,
        Cmd: cfg.Cmd,
        Entrypoint: cfg.Entrypoint,
        WorkingDir: cfg.WorkingDir,
        ExposedPorts: cfg.ExposedPorts,
        HostConfig: {
            ...hc,
            PortBindings: hc.PortBindings,
            RestartPolicy: hc.RestartPolicy,
            Binds: hc.Binds,
            NetworkMode: netNames[0] ?? hc.NetworkMode ?? "bridge",
            Mounts: hc.Mounts,
            VolumesFrom: hc.VolumesFrom,
        },
    };

    // 5. Create new container
    let newCid: string;
    try {
        const oldName = ((info.Name as string) ?? "").replace(/^\//, "");
        const path = oldName ? `/containers/create?name=${encodeURIComponent(oldName + "-new")}` : "/containers/create";
        const { code, data } = await dockerCall("POST", path, createBody);
        if (code !== 201) {
            steps.push({ step: "create-container", status: "error", output: `HTTP ${code}: ${JSON.stringify(data).slice(0, 200)}` });
            return steps;
        }
        newCid = (data as { Id: string }).Id;
        steps.push({ step: "create-container", status: "ok", output: newCid.slice(0, 12) });
    } catch (e) {
        steps.push({ step: "create-container", status: "error", output: (e as Error).message });
        return steps;
    }

    // 6. Stop old
    try {
        await dockerCall("POST", `/containers/${cid}/stop?t=10`);
        steps.push({ step: "stop-old", status: "ok", output: "Stopped" });
    } catch (e) {
        steps.push({ step: "stop-old", status: "error", output: (e as Error).message });
    }

    // 7. Start new
    try {
        await dockerCall("POST", `/containers/${newCid}/start`);
        steps.push({ step: "start-new", status: "ok", output: "New container running. Refresh in a moment." });
    } catch (e) {
        steps.push({ step: "start-new", status: "error", output: (e as Error).message });
        return steps;
    }

    // 8. Cleanup old
    try { await dockerCall("DELETE", `/containers/${cid}?force=true`); } catch { /* best effort */ }

    return steps;
}

// ===================================================================

export async function POST() {
    // Self-update runs shell commands / pulls arbitrary images / talks to the
    // Docker socket (root on host). Restrict to configured platform admins only,
    // matching the /ops UI that renders the Update button.
    const admin = await requirePlatformAdminSession();
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // ---- Docker with socket: pull + recreate ----
    if (isDocker() && fs.existsSync(DOCKER_SOCKET)) {
        const steps = await dockerUpdateSelf();
        const ok = steps.every(s => s.status !== "error");
        return NextResponse.json({ success: ok, mode: "docker", steps }, { status: ok ? 200 : 500 });
    }

    // ---- Docker without socket: tell user to mount it ----
    if (isDocker()) {
        return NextResponse.json({
            success: false, mode: "docker",
            steps: [{ step: "docker-socket", status: "error",
                output: "Docker socket not mounted. Add to app service: volumes: [/var/run/docker.sock:/var/run/docker.sock]" }],
        }, { status: 500 });
    }

    // ---- Bare-metal: git pull + build + restart ----
    const steps: UpdateStep[] = [];
    const run = async (step: string, cmd: string): Promise<UpdateStep> => {
        const entry: UpdateStep = { step, status: "running", output: "" };
        steps.push(entry);
        try {
            const { stdout, stderr } = await execAsync(cmd, { cwd: PROJECT_DIR, timeout: 180_000, env: { ...process.env, NODE_ENV: "production" } });
            entry.output = (stdout + stderr).trim();
            entry.status = "ok";
        } catch (err: unknown) {
            const e = err as { stdout?: string; stderr?: string; message?: string };
            entry.output = ((e.stdout || "") + (e.stderr || "") + (e.message || "")).trim();
            entry.status = "error";
            throw err;
        }
        return entry;
    };
    try {
        await run("git-fetch", "git fetch origin main && git reset --hard origin/main");
        await run("npm-install", "npm install");
        await run("db-migrate", "npx drizzle-kit migrate");
        await run("npm-build", "npm run build");
        await run("copy-static", "cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public");
        await run("pm2-restart", "pm2 restart emperorclaw --update-env");
        return NextResponse.json({ success: true, steps });
    } catch {
        return NextResponse.json({ success: false, steps }, { status: 500 });
    }
}

export async function GET() {
    const admin = await requirePlatformAdminSession();
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    if (isDocker()) {
        try {
            const { stdout: currentVersion } = await execAsync("node -e \"console.log(require('./package.json').version)\"", { timeout: 5000 });
            const current = currentVersion.trim();
            const ghRes = await fetch(GITHUB_RELEASES_API, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) });
            if (!ghRes.ok) return NextResponse.json({ current, latest: "unknown", updateAvailable: false, mode: "docker", error: `GitHub API: ${ghRes.status}` });
            const release = await ghRes.json() as { tag_name: string; body: string };
            const latest = (release.tag_name || "").replace(/^v/, "");
            return NextResponse.json({ current, latest, updateAvailable: latest && current !== latest, mode: "docker", changelog: release.body || null });
        } catch (err: unknown) {
            return NextResponse.json({ current: "unknown", latest: "unknown", updateAvailable: false, mode: "docker", error: (err as Error).message });
        }
    }

    // Bare-metal
    try {
        const { stdout: currentVersion } = await execAsync("node -e \"console.log(require('./package.json').version)\"", { cwd: PROJECT_DIR, timeout: 5000 });
        await execAsync("git fetch origin --tags 2>&1 || true", { cwd: PROJECT_DIR, timeout: 15000 });
        const { stdout: tagsOut } = await execAsync("git tag --sort=-creatordate | grep -E '^v[0-9]' | head -1", { cwd: PROJECT_DIR, timeout: 5000 });
        const latestTag = tagsOut.trim();
        const current = currentVersion.trim();
        const latest = latestTag.replace(/^v/, "");
        let changelog = "";
        if (latest && current !== latest) {
            try { const { stdout: log } = await execAsync(`git log v${current}..${latestTag} --oneline --no-merges 2>&1 || echo ""`, { cwd: PROJECT_DIR, timeout: 5000 }); changelog = log.trim(); } catch { /* ok */ }
        }
        return NextResponse.json({ current, latest, updateAvailable: latest && current !== latest, changelog: changelog || null });
    } catch (err: unknown) {
        return NextResponse.json({ current: "unknown", latest: "unknown", updateAvailable: false, error: (err as Error).message });
    }
}
