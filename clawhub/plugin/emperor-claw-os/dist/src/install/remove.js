import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadManifests, resolveManifestPath } from "../state/manifests.js";
import { loadThreadOwners, saveThreadOwners } from "../state/thread-owners.js";
const execFileAsync = promisify(execFile);
function shouldUseShellForCli(cliPath) {
    return process.platform === "win32" && /\.(cmd|bat)$/i.test(cliPath);
}
async function execOpenClawCli(cliPath, args) {
    return execFileAsync(cliPath, args, {
        shell: shouldUseShellForCli(cliPath)
    });
}
function parseEnvFile(filePath) {
    if (!fs.existsSync(filePath))
        return {};
    const envText = fs.readFileSync(filePath, "utf8");
    return Object.fromEntries(envText
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
        const idx = line.indexOf("=");
        const key = line.slice(0, idx);
        let value = line.slice(idx + 1);
        if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        return [key, value];
    }));
}
async function removeSystemdUnitFile(serviceName) {
    const serviceDir = path.join(os.homedir(), ".config", "systemd", "user");
    const servicePath = path.join(serviceDir, serviceName);
    if (!fs.existsSync(servicePath))
        return false;
    fs.unlinkSync(servicePath);
    try {
        await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    }
    catch { }
    return true;
}
async function removeLocalBrainAgent(agentId, openclawCliPath) {
    const cliPath = openclawCliPath || (process.platform === "win32" ? "openclaw.cmd" : "openclaw");
    const attempts = [
        ["agents", "remove", agentId, "--non-interactive"],
        ["agents", "delete", agentId, "--non-interactive"],
        ["agent", "remove", "--agent", agentId, "--non-interactive"],
        ["agent", "delete", "--agent", agentId, "--non-interactive"]
    ];
    for (const args of attempts) {
        try {
            await execOpenClawCli(cliPath, args);
            return true;
        }
        catch { }
    }
    return false;
}
function removeMatchingThreadOwners(paths, emperorAgentId) {
    if (!emperorAgentId)
        return 0;
    const owners = loadThreadOwners(paths);
    let removed = 0;
    for (const [threadId, ownerId] of Object.entries(owners)) {
        if (ownerId === emperorAgentId) {
            delete owners[threadId];
            removed += 1;
        }
    }
    saveThreadOwners(paths, owners);
    return removed;
}
export async function removeTrackedAgent(paths, input) {
    const localBrainAgentId = String(input.localBrainAgentId || "");
    const manifests = loadManifests(paths);
    const manifest = manifests.find((row) => row.localBrainAgentId === localBrainAgentId);
    if (!manifest)
        return null;
    try {
        await execFileAsync("systemctl", ["--user", "disable", "--now", manifest.serviceName]);
    }
    catch { }
    const systemdUnitRemoved = await removeSystemdUnitFile(manifest.serviceName);
    const manifestPath = resolveManifestPath(paths, localBrainAgentId);
    if (fs.existsSync(manifestPath))
        fs.unlinkSync(manifestPath);
    const envVars = parseEnvFile(path.join(manifest.companionDir, ".env"));
    let companionRemoved = false;
    if (input.removeCompanionDir && fs.existsSync(manifest.companionDir)) {
        fs.rmSync(manifest.companionDir, { recursive: true, force: true });
        companionRemoved = true;
    }
    const workspaceDir = path.join(process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"), `workspace-${localBrainAgentId}`);
    let workspaceRemoved = false;
    if (input.removeWorkspace && fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        workspaceRemoved = true;
    }
    const localBrainAgentRemovalAttempted = Boolean(input.removeLocalBrainAgent);
    const localBrainAgentRemoved = localBrainAgentRemovalAttempted
        ? await removeLocalBrainAgent(localBrainAgentId, envVars.OPENCLAW_CLI_PATH)
        : false;
    const threadBindingsRemoved = removeMatchingThreadOwners(paths, manifest.agentId);
    return {
        localBrainAgentId,
        manifestPath,
        threadBindingsRemoved,
        systemdUnitRemoved,
        companionRemoved,
        workspaceRemoved,
        localBrainAgentRemoved,
        localBrainAgentRemovalAttempted
    };
}
