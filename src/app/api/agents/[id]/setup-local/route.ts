import { NextRequest, NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/roles";
import { db } from "@/db";
import { agents, companyTokens } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { exec, spawn } from "child_process";
import { getProvider } from "@/lib/agent-providers";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { DOCKER_SOCKET, isDocker } from "@/lib/docker";
import { provisionHermesContainer } from "@/lib/hermes-provisioning";
import { hermesSafeName } from "@/lib/hermes-names";

export const dynamic = "force-dynamic";

type SetupOutput = { command: string; stdout: string; stderr: string; exitCode: number | null };

/**
 * POST /api/agents/[id]/setup-local
 *
 * Full local agent setup:
 * - Hermes: profile, plugin, token, bridge .env, bridge process start ONLINE
 * - Hermes is the only supported local runtime
 */
export async function POST(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    let ctx;
    try {
        ctx = await requireRole("admin")();
    } catch (err) {
        if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
        throw err;
    }
    const companyId = ctx.companyId;

    const { id } = await params;
    const [agent] = await db.select().from(agents).where(
        and(eq(agents.id, id), eq(agents.companyId, companyId), isNull(agents.deletedAt))
    ).limit(1);

    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    if (agent.deploymentMode !== "local") {
        return NextResponse.json({ error: "This agent is deployed remotely." }, { status: 400 });
    }

    const provider = getProvider(agent.provider || "mcp");
    if (provider?.id !== "hermes") return NextResponse.json({ error: "Unknown provider" }, { status: 400 });

    // Project root: prefer EMPEROR_PROJECT_ROOT env var, fall back to cwd
    const projectRoot = process.env.EMPEROR_PROJECT_ROOT || process.cwd();
    // In dev mode (next dev), cwd is already the project root.
    // In production standalone, set EMPEROR_PROJECT_ROOT=/var/www/emperorclaw
    const safeName = hermesSafeName(agent.name);
    // `role` is interpolated into shell command strings below (profile
    // description, install commands). Even inside double quotes, bash and
    // PowerShell still interpret backslash, double quote, dollar and backtick,
    // so strip those (and control chars) to close the command-injection hole.
    const role = sanitizeShellValue(agent.role || "operator");
    const homeDir = os.homedir();
    const emperorUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";

    // Hermes data directory is platform-specific
    const hermesDataDir = process.platform === "win32"
        ? path.join(homeDir, "AppData", "Local", "hermes")
        : path.join(homeDir, ".hermes");
    const hermesBin = process.platform === "win32" ? "hermes" : path.join(homeDir, ".local", "bin", "hermes");

    // Generate API token
    const rawToken = `ec_${crypto.randomBytes(24).toString("hex")}`;
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await db.insert(companyTokens).values({
        companyId, tokenHash,
        // Bind the runtime token to this agent so it cannot act as a sibling.
        agentId: agent.id,
        name: `${safeName}-local-setup`,
        scope: "mcp_full",
    });

    const outputs: SetupOutput[] = [];

    // ── Hermes: full local setup ────────────────────────────────────
    if (provider.id === "hermes") {
        // Docker sibling-container path takes over entirely when the app is
        // itself running in Docker with the socket mounted — a bare exec/spawn
        // inside this container would die on the next self-update/restart and
        // Hermes isn't even installed in the app image. Falls through to the
        // existing bare-metal logic below, byte-for-byte, when Docker isn't
        // available (true bare metal, or an install that hasn't mounted the
        // socket yet).
        const dockerAvailable = isDocker() && fs.existsSync(DOCKER_SOCKET);
        if (dockerAvailable) {
            const result = await provisionHermesContainer({ agent, apiToken: rawToken, safeName, role });
            if (result.success && result.containerId) {
                await db.update(agents).set({
                    containerId: result.containerId,
                    containerName: result.containerName,
                }).where(eq(agents.id, agent.id));
            }
            if (!result.success) return fail(outputs.concat(result.outputs), result.message, agent.id);
            return NextResponse.json({ success: true, message: result.message, token: rawToken, outputs: outputs.concat(result.outputs) });
        }

        // 1. Create profile (skip if exists — idempotent)
        const createCmd = `hermes profile create ${safeName} --clone --description "${role}" --no-alias`;
        const r1 = await runCmd(createCmd, 30_000);
        outputs.push({ command: createCmd, ...r1 });
        // Profile already exists is OK — continue
        const alreadyExists = r1.stderr.includes("already exists") || r1.stdout.includes("already exists");
        if (r1.exitCode !== 0 && !alreadyExists) return fail(outputs, "Hermes profile creation failed", agent.id);

        // 2. Update plugin files and clear stale bytecode
        const pluginSrc = path.join(projectRoot, "integrations", "hermes", "emperor-claw");
        const globalPluginDir = path.join(hermesDataDir, "plugins", "emperor-claw");
        const copyCmd = process.platform === "win32"
            ? `powershell -Command "Remove-Item -Recurse -Force '${globalPluginDir.replace(/'/g, "''")}\\__pycache__' -ErrorAction SilentlyContinue; Copy-Item -Recurse -Force '${pluginSrc.replace(/'/g, "''")}\\*' '${globalPluginDir.replace(/'/g, "''")}\\'"`
            : `rm -rf '${globalPluginDir}/__pycache__' 2>/dev/null; mkdir -p '${globalPluginDir}' && cp -R '${pluginSrc}/'* '${globalPluginDir}/'`;
        const r2 = await runCmd(copyCmd, 15_000);
        outputs.push({ command: `Update global plugin → ${globalPluginDir}`, ...r2 });
        if (r2.exitCode !== 0) return fail(outputs, "Plugin update failed", agent.id);

        // 3. Ensure plugin is enabled globally
        const enableCmd = `hermes plugins enable emperor-claw`;
        const r3 = await runCmd(enableCmd, 10_000);
        outputs.push({ command: enableCmd, stdout: r3.stdout || (r3.exitCode === 0 ? "Plugin enabled" : ""), stderr: r3.stderr, exitCode: r3.exitCode });
        // Enable failure is non-fatal if already enabled

        // 4. Write bridge .env
        const bridgeDir = path.join(hermesDataDir, "emperor-bridge", safeName);
        const bridgeStatePath = path.join(bridgeDir, "state.json");
        const bridgeEnv = [
            `EMPEROR_CLAW_API_URL="${emperorUrl}"`,
            `EMPEROR_CLAW_API_TOKEN="${rawToken}"`,
            `EMPEROR_CLAW_AGENT_NAME="${safeName}"`,
            `EMPEROR_CLAW_AGENT_ID="${agent.id}"`,
            `EMPEROR_CLAW_AGENT_ROLE="${role}"`,
            `EMPEROR_CLAW_RUNTIME_ID="hermes-${safeName}-${os.hostname()}-1"`,
            `EMPEROR_CLAW_HERMES_POLL_SECONDS="5"`,
            `EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS="300"`,
            `HERMES_BIN="${hermesBin}"`,
            `HERMES_TOOLSETS="emperor-claw,web,terminal,code_execution"`,
            `EMPEROR_CLAW_HERMES_STATE_PATH="${bridgeStatePath}"`,
            `DEEPSEEK_API_KEY="<your-model-api-key>"`,
        ].join("\n") + "\n";
        try {
            fs.mkdirSync(bridgeDir, { recursive: true });
            fs.writeFileSync(path.join(bridgeDir, ".env"), bridgeEnv);
            outputs.push({ command: `Write bridge .env to ${bridgeDir}`, stdout: "Created", stderr: "", exitCode: 0 });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Unknown";
            return fail(outputs, `Bridge .env write failed: ${msg}`, agent.id);
        }

        // 5. Kill any existing bridge for this agent (prevent duplicates)
        const killCmd = process.platform === "win32"
            ? `taskkill /F /FI "WINDOWTITLE eq *${safeName}*" 2>nul & taskkill /F /IM python.exe 2>nul`
            : `pkill -f "emperor_hermes_bridge.*${safeName}" 2>/dev/null; sleep 1`;
        const r5 = await runCmd(killCmd, 10_000);
        outputs.push({ command: `Kill existing bridge (if any)`, stdout: r5.stdout || "Done", stderr: r5.stderr, exitCode: 0 });

        // 6. Start bridge in background (no window, survives parent exit)
        const bridgeScript = path.join(globalPluginDir, "bridge", "emperor_hermes_bridge.py");
        try {
            // On Windows, use start /B to run without a console window
            // On Unix, use nohup to survive parent exit
            const isWin = process.platform === "win32";
            const bridgeCmd = isWin
                ? `start "" /B python "${bridgeScript}"`
                : `nohup python "${bridgeScript}" > /dev/null 2>&1 &`;
            const bridgeProc = spawn(isWin ? "cmd.exe" : "sh", [isWin ? "/c" : "-c", bridgeCmd], {
                env: {
                    ...process.env,
                    EMPEROR_CLAW_API_URL: emperorUrl,
                    EMPEROR_CLAW_API_TOKEN: rawToken,
                    EMPEROR_CLAW_AGENT_NAME: safeName,
                    EMPEROR_CLAW_AGENT_ID: agent.id,
                    EMPEROR_CLAW_AGENT_ROLE: role,
                    EMPEROR_CLAW_RUNTIME_ID: `hermes-${safeName}-${os.hostname()}-1`,
                    EMPEROR_CLAW_HERMES_POLL_SECONDS: "5",
                    EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS: "300",
                    EMPEROR_CLAW_HERMES_STATE_PATH: bridgeStatePath,
                    HERMES_BIN: hermesBin,
                    HERMES_TOOLSETS: "emperor-claw,web,terminal,code_execution",
                },
                detached: true,
                stdio: "ignore",
                windowsHide: true,
            });
            bridgeProc.unref();
            outputs.push({ command: `Start bridge PID ${bridgeProc.pid}`, stdout: "Bridge started", stderr: "", exitCode: 0 });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Unknown";
            return fail(outputs, `Bridge start failed: ${msg}`, agent.id);
        }

        await db.update(agents).set({ status: "online", lastSeenAt: new Date() }).where(eq(agents.id, agent.id));
        return NextResponse.json({ success: true, message: `${agent.name} is LIVE! Bridge running in background. The agent will reply to messages.`, token: rawToken, outputs });
    }

    return NextResponse.json({ error: "Only Hermes supports local deployment" }, { status: 400 });
}

function fail(outputs: SetupOutput[], message: string, agentId: string) {
    db.update(agents).set({ status: "offline" }).where(eq(agents.id, agentId)).catch(() => {});
    return NextResponse.json({ success: false, message, outputs }, { status: 200 });
}

function sanitizeShellValue(value: string): string {
    return String(value ?? "").replace(/[\\"$`\r\n\u0000-\u001f]/g, "").slice(0, 200);
}

function runCmd(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve) => {
        const child = exec(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024, shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash" }, (error, stdout, stderr) => {
            resolve({ stdout: stdout.trim(), stderr: stderr.trim() || (error?.message ?? ""), exitCode: error?.code ?? 0 });
        });
        const killer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }, timeoutMs + 5000);
        child.on("close", () => clearTimeout(killer));
    });
}
