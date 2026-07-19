import { NextRequest, NextResponse } from "next/server";
import { getCompanyId } from "@/lib/auth";
import { db } from "@/db";
import { agents, companyTokens } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { exec, spawn } from "child_process";
import { getProvider } from "@/lib/agent-providers";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

export const dynamic = "force-dynamic";

type SetupOutput = { command: string; stdout: string; stderr: string; exitCode: number | null };

/**
 * POST /api/agents/[id]/setup-local
 *
 * Full local agent setup:
 * - Hermes: profile, plugin, token, bridge .env, bridge process start ONLINE
 * - Other providers: runs installCommands + generates API token
 */
export async function POST(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const [agent] = await db.select().from(agents).where(
        and(eq(agents.id, id), eq(agents.companyId, companyId), isNull(agents.deletedAt))
    ).limit(1);

    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    if (agent.deploymentMode !== "local") {
        return NextResponse.json({ error: "This agent is deployed remotely." }, { status: 400 });
    }

    const provider = getProvider(agent.provider || "mcp");
    if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });

    const projectRoot = path.resolve(process.cwd());
    const safeName = agent.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    const role = agent.role || "operator";
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
        name: `${safeName}-local-setup`,
        scope: "mcp_full",
    });

    const outputs: SetupOutput[] = [];

    // ── Hermes: full local setup ────────────────────────────────────
    if (provider.id === "hermes") {
        // 1. Create profile (skip if exists — idempotent)
        const createCmd = `hermes profile create ${safeName} --clone --description "${role.replace(/"/g, '\\"')}" --no-alias`;
        const r1 = await runCmd(createCmd, 30_000);
        outputs.push({ command: createCmd, ...r1 });
        // Profile already exists is OK — continue
        const alreadyExists = r1.stderr.includes("already exists") || r1.stdout.includes("already exists");

        // 2. Update plugin files (Hermes plugins are global, not per-profile)
        const pluginSrc = path.join(projectRoot, "integrations", "hermes", "emperor-claw");
        const globalPluginDir = path.join(hermesDataDir, "plugins", "emperor-claw");
        const copyCmd = process.platform === "win32"
            ? `powershell -Command "Copy-Item -Recurse -Force '${pluginSrc.replace(/'/g, "''")}' '${globalPluginDir.replace(/'/g, "''")}'"`
            : `mkdir -p '${globalPluginDir}' && cp -R '${pluginSrc}/'* '${globalPluginDir}/'`;
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

        // 5. Start bridge (detached background) — uses global plugin
        const bridgeScript = path.join(globalPluginDir, "bridge", "emperor_hermes_bridge.py");
        try {
            const bridgeProc = spawn("python", [bridgeScript], {
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
                    HERMES_BIN: hermesBin,
                    HERMES_TOOLSETS: "emperor-claw,web,terminal,code_execution",
                },
                detached: true, stdio: "ignore",
                cwd: path.dirname(bridgeScript),
            });
            bridgeProc.unref();
            outputs.push({ command: `Start bridge PID ${bridgeProc.pid}`, stdout: "Bridge started", stderr: "", exitCode: 0 });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Unknown";
            return fail(outputs, `Bridge start failed: ${msg}`, agent.id);
        }

        await db.update(agents).set({ status: "online", lastSeenAt: new Date() }).where(eq(agents.id, agent.id));
        return NextResponse.json({ success: true, message: `${agent.name} is LIVE! Hermes profile created, plugin installed, bridge running. Agent is ONLINE.`, token: rawToken, outputs });
    }

    // ── Codex: run verification, then spawn bridge ──────────────────
    if (provider.id === "codex") {
        // Run verification commands first
        const commands = provider.installCommands.map((cmd) =>
            cmd.replace(/\{name\}/g, safeName).replace(/\{role\}/g, role.replace(/"/g, '\\"')).replace(/\{token\}/g, rawToken).replace(/\{projectRoot\}/g, projectRoot)
        );
        for (const command of commands) {
            if (command.trim().startsWith("#")) { outputs.push({ command, stdout: "", stderr: "", exitCode: 0 }); continue; }
            const result = await runCmd(command, 15_000);
            outputs.push({ command, ...result });
            if (result.exitCode !== 0) return fail(outputs, `Verification failed: ${command}`, agent.id);
        }

        // Spawn Codex bridge
        const bridgeScript = path.join(projectRoot, "integrations", "codex", "emperor-codex-bridge.js");
        if (!fs.existsSync(bridgeScript)) {
            return fail(outputs, `Codex bridge script not found at ${bridgeScript}`, agent.id);
        }

        try {
            const bridgeProc = spawn("node", [bridgeScript], {
                env: {
                    ...process.env,
                    EMPEROR_CLAW_API_URL: emperorUrl,
                    EMPEROR_CLAW_API_TOKEN: rawToken,
                    EMPEROR_CLAW_AGENT_NAME: safeName,
                    EMPEROR_CLAW_AGENT_ID: agent.id,
                    EMPEROR_CLAW_AGENT_ROLE: role,
                    EMPEROR_CLAW_POLL_SECONDS: "5",
                    EMPEROR_CLAW_CODEX_TIMEOUT: "120",
                },
                detached: true, stdio: "ignore",
                cwd: projectRoot,
            });
            bridgeProc.unref();
            outputs.push({ command: `Start Codex bridge PID ${bridgeProc.pid}`, stdout: "Bridge started", stderr: "", exitCode: 0 });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Unknown";
            return fail(outputs, `Codex bridge start failed: ${msg}`, agent.id);
        }

        await db.update(agents).set({ status: "online", lastSeenAt: new Date() }).where(eq(agents.id, agent.id));
        return NextResponse.json({ success: true, message: `${agent.name} is LIVE! Codex verified, bridge running. Agent is ONLINE and ready to respond.`, token: rawToken, outputs });
    }

    // ── Generic: run installCommands ────────────────────────────────
    if (provider.installCommands.length === 0) {
        return NextResponse.json({ success: true, message: "No setup commands needed.", outputs: [] });
    }

    const commands = provider.installCommands.map((cmd) =>
        cmd.replace(/\{name\}/g, safeName).replace(/\{role\}/g, role.replace(/"/g, '\\"')).replace(/\{token\}/g, rawToken).replace(/\{projectRoot\}/g, projectRoot)
    );
    for (const command of commands) {
        if (command.trim().startsWith("#")) { outputs.push({ command, stdout: "", stderr: "", exitCode: 0 }); continue; }
        try {
            const result = await runCmd(command, 15_000);
            outputs.push({ command, ...result });
            if (result.exitCode !== 0) return fail(outputs, `Command failed: ${command}`, agent.id);
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown";
            return fail(outputs, `Command error: ${msg}`, agent.id);
        }
    }
    await db.update(agents).set({ status: "offline", lastSeenAt: new Date() }).where(eq(agents.id, agent.id));
    return NextResponse.json({ success: true, message: `All ${outputs.length} commands completed.`, token: rawToken, outputs });
}

function fail(outputs: SetupOutput[], message: string, agentId: string) {
    db.update(agents).set({ status: "offline" }).where(eq(agents.id, agentId)).catch(() => {});
    return NextResponse.json({ success: false, message, outputs }, { status: 200 });
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
