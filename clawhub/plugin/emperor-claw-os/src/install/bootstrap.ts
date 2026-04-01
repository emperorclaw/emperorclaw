import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import type { EmperorPluginPaths } from "../state/paths.js";
import { writeManifest, type EmperorAgentManifest } from "../state/manifests.js";
import { writeWorkspaceBootstrap } from "./workspace.js";
import { reloadAndRestartService, startFallbackBridge } from "../runtime/services.js";

const execFileAsync = promisify(execFile);

export type BootstrapAgentInput = {
  apiUrl: string;
  token: string;
  agentName: string;
  localBrainAgentId: string;
  profile: "operator" | "manager";
  ownerName: string;
  ownerTimezone: string;
  thinking: string;
};

export type BootstrapResult = {
  manifestPath: string;
  manifest: EmperorAgentManifest;
  serviceName: string;
  companionDir: string;
};

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveOpenClawHome(): string {
  return process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
}

function resolveOpenClawCliPath(): string {
  if (process.env.OPENCLAW_CLI_PATH) return process.env.OPENCLAW_CLI_PATH;
  const fallback = path.join(os.homedir(), ".npm-global", "bin", "openclaw");
  if (fs.existsSync(fallback)) return fallback;
  return "openclaw";
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

async function ensureRuntimeDeps(runtimeDir: string): Promise<void> {
  const packageJsonPath = path.join(runtimeDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    fs.writeFileSync(packageJsonPath, JSON.stringify({
      name: "emperor-control-plane-runtime",
      private: true,
      version: "2.0.0",
      description: "Runtime dependencies for the Emperor Claw OpenClaw bridge",
      dependencies: { ws: "^8.18.0" }
    }, null, 2) + "\n", "utf8");
  }
  execSync(`npm --prefix ${JSON.stringify(runtimeDir)} install --silent`, { stdio: "inherit" });
}

async function runControlPlaneBootstrap(runtimeDir: string, companionDir: string, stateDir: string, bridgeStatePath: string, input: BootstrapAgentInput, runtimeId: string): Promise<void> {
  await execFileAsync("node", [
    path.join(runtimeDir, "control-plane.js"),
    "bootstrap",
    "--openclaw-home", resolveOpenClawHome(),
    "--api-base-url", input.apiUrl,
    "--token", input.token,
    "--agent-name", input.agentName,
    "--runtime-id", runtimeId
  ], {
    env: {
      ...process.env,
      EMPEROR_CLAW_COMPANION_DIR: companionDir,
      EMPEROR_CLAW_STATE_DIR: stateDir,
      EMPEROR_CLAW_BRIDGE_STATE_PATH: bridgeStatePath
    }
  });
}

async function resolveEmperorAgentId(apiUrl: string, token: string, agentName: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("curl", [
      "-sS",
      "-H", `Authorization: Bearer ${token}`,
      `${apiUrl}/api/mcp/agents?limit=200`
    ]);
    const payload = JSON.parse(stdout);
    const rows = Array.isArray(payload?.agents) ? payload.agents : [];
    const match = rows.find((row: any) => String(row?.name || "").trim() === String(agentName || "").trim());
    return match?.id;
  } catch {
    return undefined;
  }
}

async function ensureLocalBrainAgent(localBrainAgentId: string, workspaceDir: string, agentName: string): Promise<void> {
  const openclaw = resolveOpenClawCliPath();
  let exists = false;
  try {
    const { stdout } = await execFileAsync(openclaw, ["agents", "list", "--json"]);
    const rows = JSON.parse(stdout);
    exists = Array.isArray(rows) && rows.some((row) => row?.id === localBrainAgentId);
  } catch {
    exists = false;
  }
  if (!exists) {
    await execFileAsync(openclaw, [
      "agents", "add", localBrainAgentId,
      "--workspace", workspaceDir,
      "--model", "openai-codex/gpt-5.4",
      "--non-interactive"
    ]);
  }
  await execFileAsync(openclaw, ["agents", "set-identity", "--agent", localBrainAgentId, "--name", agentName, "--emoji", "🧠"]);
}

function writeEnvFile(envFile: string, values: Record<string, string>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  fs.writeFileSync(envFile, `${lines.join("\n")}\n`, "utf8");
}

function writeBridgeConfig(companionDir: string, values: Record<string, string>): void {
  const configPath = path.join(companionDir, "bridge.config.json");
  const config = {
    apiUrl: values.EMPEROR_CLAW_API_URL,
    agentName: values.EMPEROR_CLAW_AGENT_NAME,
    profile: values.EMPEROR_CLAW_AGENT_PROFILE,
    runtimeId: values.EMPEROR_CLAW_RUNTIME_ID,
    brainAgentId: values.EMPEROR_CLAW_BRAIN_AGENT_ID,
    thinking: values.EMPEROR_CLAW_BRAIN_THINKING,
    stateDir: values.EMPEROR_CLAW_STATE_DIR,
    bridgeStatePath: values.EMPEROR_CLAW_BRIDGE_STATE_PATH
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function writeRunBridge(companionDir: string): void {
  const runBridgePath = path.join(companionDir, "run-bridge.sh");
  fs.writeFileSync(runBridgePath, `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
set -a
source "$SCRIPT_DIR/.env"
set +a
export EMPEROR_CLAW_CONFIG_PATH="$SCRIPT_DIR/bridge.config.json"
export EMPEROR_CLAW_RECONNECT_BASE_MS="\${EMPEROR_CLAW_RECONNECT_BASE_MS:-2000}"
export EMPEROR_CLAW_RECONNECT_MAX_MS="\${EMPEROR_CLAW_RECONNECT_MAX_MS:-60000}"
exec node "$SCRIPT_DIR/runtime/bridge.js"
`, "utf8");
  fs.chmodSync(runBridgePath, 0o755);
}

function writeSystemdService(serviceNameBase: string, envFile: string, companionDir: string): void {
  const serviceDir = path.join(os.homedir(), ".config", "systemd", "user");
  ensureDir(serviceDir);
  const servicePath = path.join(serviceDir, `${serviceNameBase}.service`);
  fs.writeFileSync(servicePath, `[Unit]
Description=Emperor Claw bridge for OpenClaw
After=network-online.target openclaw-gateway.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${envFile}
ExecStart=${path.join(companionDir, "run-bridge.sh")}
WorkingDirectory=${companionDir}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`, "utf8");
}

function copyRuntimeAssets(pluginRoot: string, runtimeDir: string, companionDir: string): void {
  ensureDir(runtimeDir);
  fs.copyFileSync(path.join(pluginRoot, "examples", "bridge.js"), path.join(runtimeDir, "bridge.js"));
  const controlPlaneUrl = `${process.env.EMPEROR_CLAW_API_URL || "https://emperorclaw.malecu.eu"}/downloads/control-plane.js`;
  execSync(`curl -fsSL ${JSON.stringify(controlPlaneUrl)} -o ${JSON.stringify(path.join(runtimeDir, "control-plane.js"))}`, { stdio: "inherit" });
  fs.chmodSync(path.join(runtimeDir, "bridge.js"), 0o755);
  fs.chmodSync(path.join(runtimeDir, "control-plane.js"), 0o755);
  const doctorLocal = path.join(pluginRoot, "scripts", "doctor-local.sh");
  if (fs.existsSync(doctorLocal)) {
    fs.copyFileSync(doctorLocal, path.join(companionDir, "doctor.sh"));
    fs.chmodSync(path.join(companionDir, "doctor.sh"), 0o755);
  }
}

export async function bootstrapAgent(paths: EmperorPluginPaths, input: BootstrapAgentInput): Promise<BootstrapResult> {
  if (!input.token?.trim()) throw new Error("Emperor token is required");
  if (!input.agentName?.trim()) throw new Error("Agent name is required");
  if (!input.localBrainAgentId?.trim()) throw new Error("Local brain agent id is required");

  const slug = slugify(input.localBrainAgentId || input.agentName);
  const openclawHome = resolveOpenClawHome();
  const companionDir = path.join(openclawHome, `emperor-control-plane-${slug}`);
  const runtimeDir = path.join(companionDir, "runtime");
  const stateDir = path.join(companionDir, "state");
  const bridgeStatePath = path.join(stateDir, "bridge-state.json");
  const envFile = path.join(companionDir, ".env");
  const runtimeId = `${slug}-${os.hostname().toLowerCase()}`;
  const serviceNameBase = `emperor-claw-bridge-${slug}`;
  const serviceName = `${serviceNameBase}.service`;
  const workspaceDir = path.join(openclawHome, `workspace-${input.localBrainAgentId}`);
  const pluginRoot = paths.pluginRoot;

  ensureDir(companionDir);
  ensureDir(runtimeDir);
  ensureDir(stateDir);
  ensureDir(workspaceDir);

  copyRuntimeAssets(pluginRoot, runtimeDir, companionDir);
  await ensureRuntimeDeps(runtimeDir);
  await runControlPlaneBootstrap(runtimeDir, companionDir, stateDir, bridgeStatePath, input, runtimeId);
  await ensureLocalBrainAgent(input.localBrainAgentId, workspaceDir, input.agentName);
  writeWorkspaceBootstrap({
    workspaceDir,
    agentName: input.agentName,
    ownerName: input.ownerName,
    ownerTimezone: input.ownerTimezone,
    profile: input.profile
  });

  const envValues = {
    EMPEROR_CLAW_API_URL: input.apiUrl,
    EMPEROR_CLAW_API_TOKEN: input.token,
    EMPEROR_CLAW_AGENT_NAME: input.agentName,
    EMPEROR_CLAW_AGENT_PROFILE: input.profile,
    EMPEROR_CLAW_RUNTIME_ID: runtimeId,
    EMPEROR_CLAW_COMPANION_DIR: companionDir,
    EMPEROR_CLAW_STATE_DIR: stateDir,
    EMPEROR_CLAW_BRIDGE_STATE_PATH: bridgeStatePath,
    EMPEROR_CLAW_BRAIN_AGENT_ID: input.localBrainAgentId,
    EMPEROR_CLAW_BRAIN_THINKING: input.thinking,
    EMPEROR_CLAW_AUTO_CLAIM: "false",
    EMPEROR_CLAW_USE_EXECUTOR: "false",
    EMPEROR_CLAW_DEBUG_PROMPTS: "false",
    OPENCLAW_CLI_PATH: resolveOpenClawCliPath(),
    OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT || "18789"
  };

  writeEnvFile(envFile, envValues);
  writeBridgeConfig(companionDir, envValues);
  writeRunBridge(companionDir);
  writeSystemdService(serviceNameBase, envFile, companionDir);

  const serviceRestart = await reloadAndRestartService(serviceNameBase);
  if (serviceRestart.mode === "fallback") {
    await startFallbackBridge(companionDir);
  }

  const emperorAgentId = await resolveEmperorAgentId(input.apiUrl, input.token, input.agentName);

  const manifest: EmperorAgentManifest = {
    agentId: emperorAgentId,
    agentName: input.agentName,
    localBrainAgentId: input.localBrainAgentId,
    runtimeId,
    companionDir,
    serviceName,
    profile: input.profile,
    threadPolicy: {
      direct: "bound",
      team: "mention-required"
    },
    installedAt: new Date().toISOString(),
    version: "0.1.0"
  };

  const manifestPath = writeManifest(paths, slug, manifest);
  return { manifestPath, manifest, serviceName, companionDir };
}
