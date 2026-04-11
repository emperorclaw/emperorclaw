import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import type { EmperorPluginPaths } from "../state/paths.js";
import { writeManifest, type EmperorAgentManifest } from "../state/manifests.js";
import { writeWorkspaceBootstrap } from "./workspace.js";
import { reloadAndRestartService, startFallbackBridge } from "../runtime/services.js";
import { createDefaultBridgeContract, DEFAULT_THREAD_POLICY } from "../bridge/contract.js";
import { getSharedDoctrineResourceSpecs } from "./doctrine.js";
import { inferOpenClawStateDir, normalizeOpenClawProfileConfig, resolveOpenClawConfigPath } from "./openclaw-profile.js";

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
  sharedDoctrineResourceIds: string[];
};

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveOpenClawHome(): string {
  return process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
}

function resolveOpenClawCliPath(): string {
  if (process.env.OPENCLAW_CLI_PATH) return process.env.OPENCLAW_CLI_PATH;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const npmCli = path.join(appData, "npm", "openclaw.cmd");
    if (fs.existsSync(npmCli)) return npmCli;
  }
  const fallback = path.join(os.homedir(), ".npm-global", "bin", "openclaw");
  if (fs.existsSync(fallback)) return fallback;
  return process.platform === "win32" ? "openclaw.cmd" : "openclaw";
}

function resolveOpenClawCliJsPath(cliPath: string): string {
  const configured = String(process.env.OPENCLAW_CLI_JS_PATH || "").trim();
  if (configured) return configured;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cliPath)) {
    return path.join(path.dirname(cliPath), "node_modules", "openclaw", "openclaw.mjs");
  }
  return "";
}

function shouldUseShellForCli(cliPath: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(cliPath);
}

async function execOpenClawCli(
  cliPath: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const cliJsPath = resolveOpenClawCliJsPath(cliPath);
  if (process.platform === "win32" && cliJsPath && fs.existsSync(cliJsPath)) {
    return execFileAsync(process.execPath, [cliJsPath, ...args], { shell: false });
  }
  return execFileAsync(cliPath, args, {
    shell: shouldUseShellForCli(cliPath)
  });
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
    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/mcp/agents?limit=200`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return undefined;
    const payload = await response.json();
    const rows = Array.isArray(payload?.agents) ? payload.agents : [];
    const match = rows.find((row: any) => String(row?.name || "").trim() === String(agentName || "").trim());
    return match?.id;
  } catch {
    return undefined;
  }
}

function readBridgeStateAgentId(bridgeStatePath: string): string | undefined {
  if (!fs.existsSync(bridgeStatePath)) return undefined;
  try {
    const payload = JSON.parse(fs.readFileSync(bridgeStatePath, "utf8"));
    const agentId = String(payload?.lastAgentId || "").trim();
    return agentId || undefined;
  } catch {
    return undefined;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEmperorAgentId(
  apiUrl: string,
  token: string,
  agentName: string,
  bridgeStatePath: string,
): Promise<string | undefined> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const fromBridgeState = readBridgeStateAgentId(bridgeStatePath);
    if (fromBridgeState) return fromBridgeState;
    const fromName = await resolveEmperorAgentId(apiUrl, token, agentName);
    if (fromName) return fromName;
    await sleep(1000);
  }
  return readBridgeStateAgentId(bridgeStatePath) || resolveEmperorAgentId(apiUrl, token, agentName);
}

async function emperorFetch(
  apiUrl: string,
  token: string,
  pathname: string,
  init: RequestInit = {},
): Promise<any> {
  const response = await fetch(`${apiUrl.replace(/\/+$/, "")}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Emperor request failed ${response.status}: ${text || response.statusText}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function upsertCompanySharedDoctrineResources(
  apiUrl: string,
  token: string,
): Promise<string[]> {
  const createdIds: string[] = [];
  for (const spec of getSharedDoctrineResourceSpecs()) {
    const query = new URLSearchParams({
      scopeType: "company",
      provider: spec.provider,
      resourceType: spec.resourceType,
      name: spec.name,
    });
    const payload = await emperorFetch(apiUrl, token, `/api/mcp/resources?${query.toString()}`, { method: "GET" });
    const resources = Array.isArray(payload?.resources) ? payload.resources : [];
    const existing = resources.find((resource: any) =>
      String(resource?.scopeType || "").trim() === "company"
      && String(resource?.name || "").trim() === spec.name
    ) || null;
    const body = {
      name: spec.name,
      displayName: spec.displayName,
      provider: spec.provider,
      resourceType: spec.resourceType,
      configText: spec.configText,
      isShared: spec.isShared,
      status: "active",
      ownership: "managed",
    };

    if (existing?.id) {
      const updated = await emperorFetch(apiUrl, token, `/api/mcp/resources/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const updatedId = updated?.resource?.id || existing.id || null;
      if (updatedId) createdIds.push(updatedId);
      continue;
    }

    const created = await emperorFetch(apiUrl, token, "/api/mcp/resources", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const createdId = created?.resource?.id || null;
    if (createdId && created?.resource?.isShared !== spec.isShared) {
      const patched = await emperorFetch(apiUrl, token, `/api/mcp/resources/${createdId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const patchedId = patched?.resource?.id || createdId;
      if (patchedId) createdIds.push(patchedId);
      continue;
    }
    if (createdId) createdIds.push(createdId);
  }
  return createdIds;
}

async function reconcileEmperorAgentProfile(
  apiUrl: string,
  token: string,
  agentId: string,
  profile: "operator" | "manager",
): Promise<void> {
  await emperorFetch(apiUrl, token, `/api/mcp/agents/${agentId}`, {
    method: "PATCH",
    headers: {
      "Idempotency-Key": `agent-profile:${randomUUID()}`,
    },
    body: JSON.stringify({
      role: profile,
    }),
  });
}

async function ensureLocalBrainAgent(localBrainAgentId: string, workspaceDir: string, agentName: string): Promise<void> {
  const openclaw = resolveOpenClawCliPath();
  let exists = false;
  try {
    const { stdout } = await execOpenClawCli(openclaw, ["agents", "list", "--json"]);
    const rows = JSON.parse(stdout);
    exists = Array.isArray(rows) && rows.some((row) => row?.id === localBrainAgentId);
  } catch {
    exists = false;
  }
  if (!exists) {
    await execOpenClawCli(openclaw, [
      "agents", "add", localBrainAgentId,
      "--workspace", workspaceDir,
      "--model", "openai-codex/gpt-5.4",
      "--non-interactive"
    ]);
  }
  await execOpenClawCli(openclaw, ["agents", "set-identity", "--agent", localBrainAgentId, "--name", agentName, "--emoji", "brain"]);
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
    brainMode: values.EMPEROR_CLAW_BRAIN_MODE,
    thinking: values.EMPEROR_CLAW_BRAIN_THINKING,
    longTurnMessageMs: values.EMPEROR_CLAW_LONG_TURN_MESSAGE_MS,
    enableManagerReview: values.EMPEROR_CLAW_ENABLE_MANAGER_REVIEW,
    stateDir: values.EMPEROR_CLAW_STATE_DIR,
    bridgeStatePath: values.EMPEROR_CLAW_BRIDGE_STATE_PATH
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function writeRunBridge(companionDir: string): void {
  if (process.platform === "win32") {
    const runBridgePath = path.join(companionDir, "run-bridge.ps1");
    fs.writeFileSync(runBridgePath, `$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Get-Content (Join-Path $scriptDir ".env") | ForEach-Object {
  if ([string]::IsNullOrWhiteSpace($_)) { return }
  $idx = $_.IndexOf("=")
  if ($idx -lt 1) { return }
  $key = $_.Substring(0, $idx)
  $raw = $_.Substring($idx + 1)
  try {
    $value = $raw | ConvertFrom-Json
  } catch {
    $value = $raw.Trim('"')
  }
  Set-Item -Path ("Env:" + $key) -Value ([string]$value)
}
$env:EMPEROR_CLAW_CONFIG_PATH = Join-Path $scriptDir "bridge.config.json"
if (-not $env:EMPEROR_CLAW_RECONNECT_BASE_MS) { $env:EMPEROR_CLAW_RECONNECT_BASE_MS = "2000" }
if (-not $env:EMPEROR_CLAW_RECONNECT_MAX_MS) { $env:EMPEROR_CLAW_RECONNECT_MAX_MS = "60000" }
& $env:EMPEROR_CLAW_NODE_BIN (Join-Path $scriptDir "runtime/bridge.js")
`, "utf8");
    return;
  }

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
exec "$EMPEROR_CLAW_NODE_BIN" "$SCRIPT_DIR/runtime/bridge.js"
`, "utf8");
  fs.chmodSync(runBridgePath, 0o755);
}

function writeSystemdService(serviceNameBase: string, envFile: string, companionDir: string): void {
  if (process.platform === "win32") return;
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
  fs.copyFileSync(path.join(pluginRoot, "runtime", "bridge.cjs"), path.join(runtimeDir, "bridge.js"));
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
  const openclawStateDir = inferOpenClawStateDir(pluginRoot);
  const openclawConfigPath = resolveOpenClawConfigPath(pluginRoot);
  const openclawCliPath = resolveOpenClawCliPath();
  const openclawCliJsPath = resolveOpenClawCliJsPath(openclawCliPath);

  ensureDir(companionDir);
  ensureDir(runtimeDir);
  ensureDir(stateDir);
  ensureDir(workspaceDir);

  copyRuntimeAssets(pluginRoot, runtimeDir, companionDir);
  await ensureRuntimeDeps(runtimeDir);
  await runControlPlaneBootstrap(runtimeDir, companionDir, stateDir, bridgeStatePath, input, runtimeId);
  await ensureLocalBrainAgent(input.localBrainAgentId, workspaceDir, input.agentName);
  normalizeOpenClawProfileConfig(openclawConfigPath);
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
    EMPEROR_CLAW_BRAIN_MODE: "auto",
    EMPEROR_CLAW_BRAIN_THINKING: input.thinking,
    EMPEROR_CLAW_LONG_TURN_MESSAGE_MS: "20000",
    EMPEROR_CLAW_BRAIN_WORKSPACE: workspaceDir,
    EMPEROR_CLAW_AUTO_CLAIM: "false",
    EMPEROR_CLAW_ENABLE_MANAGER_REVIEW: "false",
    EMPEROR_CLAW_USE_EXECUTOR: "true",
    EMPEROR_CLAW_DEBUG_PROMPTS: "false",
    EMPEROR_CLAW_NODE_BIN: process.execPath,
    OPENCLAW_CLI_PATH: openclawCliPath,
    ...(openclawCliJsPath ? { OPENCLAW_CLI_JS_PATH: openclawCliJsPath } : {}),
    ...(openclawStateDir ? { OPENCLAW_STATE_DIR: openclawStateDir } : {}),
    ...(openclawConfigPath ? { OPENCLAW_CONFIG_PATH: openclawConfigPath } : {}),
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

  const emperorAgentId = await waitForEmperorAgentId(input.apiUrl, input.token, input.agentName, bridgeStatePath);
  if (emperorAgentId) {
    await reconcileEmperorAgentProfile(input.apiUrl, input.token, emperorAgentId, input.profile);
  }
  const sharedDoctrineResourceIds = await upsertCompanySharedDoctrineResources(input.apiUrl, input.token);

  const manifest: EmperorAgentManifest = {
    agentId: emperorAgentId,
    agentName: input.agentName,
    localBrainAgentId: input.localBrainAgentId,
    runtimeId,
    companionDir,
    serviceName,
    profile: input.profile,
    sharedDoctrineResourceIds,
    doctrineResourceId: sharedDoctrineResourceIds[0] || null,
    threadPolicy: { ...DEFAULT_THREAD_POLICY },
    bridgeContract: createDefaultBridgeContract(),
    installedAt: new Date().toISOString(),
    version: "0.1.7"
  };

  const manifestPath = writeManifest(paths, slug, manifest);
  return { manifestPath, manifest, serviceName, companionDir, sharedDoctrineResourceIds };
}
