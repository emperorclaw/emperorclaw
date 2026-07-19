import { NextRequest, NextResponse } from "next/server";
import { getCompanyId } from "@/lib/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { exec } from "child_process";
import { getProvider } from "@/lib/agent-providers";
import path from "path";

export const dynamic = "force-dynamic";

/**
 * POST /api/agents/[id]/setup-local
 *
 * Runs the provider's install commands on the server for a locally-deployed agent.
 * Only works when deployment_mode = 'local'.
 */
export async function POST(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;

    // Fetch the agent
    const [agent] = await db.select().from(agents).where(
        and(eq(agents.id, id), eq(agents.companyId, companyId), isNull(agents.deletedAt))
    ).limit(1);

    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

    // Only local agents can be set up from the server
    if (agent.deploymentMode !== "local") {
        return NextResponse.json({
            error: "This agent is deployed remotely. Run the setup commands on the target machine instead.",
        }, { status: 400 });
    }

    const provider = getProvider(agent.provider || "mcp");
    if (!provider || provider.installCommands.length === 0) {
        return NextResponse.json({
            success: true,
            message: "No setup commands needed for this provider.",
            outputs: [],
        });
    }

    // Build commands with placeholders replaced
    const projectRoot = path.resolve(process.cwd());
    const name = agent.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    const role = (agent.role || "operator").replace(/"/g, '\\"');
    // We don't have a token here — the user should generate one from Settings
    const token = "YOUR_TOKEN";

    const commands = provider.installCommands.map((cmd) =>
        cmd
            .replace(/\{name\}/g, name)
            .replace(/\{role\}/g, role)
            .replace(/\{token\}/g, token)
            .replace(/\{projectRoot\}/g, projectRoot)
    );

    // Run commands sequentially
    const outputs: { command: string; stdout: string; stderr: string; exitCode: number | null }[] = [];

    for (const command of commands) {
        // Skip comment lines
        if (command.trim().startsWith("#")) {
            outputs.push({ command, stdout: "", stderr: "", exitCode: 0 });
            continue;
        }

        try {
            const result = await runCommand(command, 15_000); // 15s timeout per command
            outputs.push({ command, ...result });
            if (result.exitCode !== 0) {
                return NextResponse.json({
                    success: false,
                    message: `Command failed: ${command}`,
                    outputs,
                    failedAt: outputs.length,
                });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            outputs.push({ command, stdout: "", stderr: message, exitCode: -1 });
            return NextResponse.json({
                success: false,
                message: `Command error: ${message}`,
                outputs,
                failedAt: outputs.length,
            });
        }
    }

    // Update agent status to "offline" (it will go online once the agent starts sending heartbeats)
    await db.update(agents)
        .set({ status: "offline", lastSeenAt: new Date() })
        .where(eq(agents.id, id));

    return NextResponse.json({
        success: true,
        message: `All ${outputs.length} setup commands completed. The agent will appear as online once it starts sending heartbeats.`,
        outputs,
    });
}

function runCommand(
    command: string,
    timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
        const child = exec(command, {
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024, // 1MB
            shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash",
        }, (error, stdout, stderr) => {
            if (error) {
                resolve({
                    stdout: stdout.trim(),
                    stderr: stderr.trim() || error.message,
                    exitCode: error.code ?? -1,
                });
            } else {
                resolve({
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    exitCode: 0,
                });
            }
        });

        // Safety: kill after timeout + 5s grace
        const killer = setTimeout(() => {
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 5000);
        }, timeoutMs + 5000);

        child.on("close", () => clearTimeout(killer));
    });
}
