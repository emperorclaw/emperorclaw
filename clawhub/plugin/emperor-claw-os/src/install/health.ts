import fs from "node:fs";
import path from "node:path";
import type { EmperorPluginPaths } from "../state/paths.js";
import { loadManifests, type EmperorAgentManifest } from "../state/manifests.js";
import { loadThreadOwners } from "../state/thread-owners.js";
import { serviceIsActive, fallbackLogExists } from "../runtime/services.js";
import { BRIDGE_CONTRACT_VERSION, getMissingBridgeCapabilities, hasRequiredThreadPolicy } from "../bridge/contract.js";
import { inspectTrackedManifestUpgrades } from "../state/normalize.js";
import { loadLocalConfig } from "./config.js";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type AgentDoctorReport = {
  agentName: string;
  serviceName: string;
  checks: DoctorCheck[];
};

const DEFAULT_EMPEROR_API_URL = "https://emperorclaw.malecu.eu";

function readBridgeUpdatedAt(bridgeStatePath: string): number | null {
  if (!fs.existsSync(bridgeStatePath)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(bridgeStatePath, "utf8"));
    const updatedAt = payload?.updatedAt;
    if (!updatedAt) return null;
    const updatedMs = new Date(updatedAt).getTime();
    return Number.isFinite(updatedMs) ? updatedMs : null;
  } catch {
    return null;
  }
}

async function checkSystemdService(serviceName: string, bridgeStatePath: string): Promise<DoctorCheck> {
  if (process.platform === "win32") {
    const updatedMs = readBridgeUpdatedAt(bridgeStatePath);
    if (updatedMs) {
      const ageSec = Math.max(0, Math.round((Date.now() - updatedMs) / 1000));
      return {
        name: "service",
        ok: ageSec < 600,
        detail: ageSec < 600
          ? `fallback bridge active on win32; bridge state updated ${ageSec}s ago`
          : `fallback bridge stale on win32; bridge state updated ${ageSec}s ago`
      };
    }
    return {
      name: "service",
      ok: false,
      detail: "win32 bridge fallback has no bridge-state heartbeat yet"
    };
  }

  const active = await serviceIsActive(serviceName);
  return { name: "service", ok: active, detail: active ? `${serviceName} active` : `${serviceName} inactive or unavailable` };
}



function checkManifestConsistency(manifest: EmperorAgentManifest): DoctorCheck {
  const expectedService = `${manifest.serviceName}`;
  const hasRuntimeId = Boolean(manifest.runtimeId && String(manifest.runtimeId || "").trim());
  return {
    name: "manifestConsistency",
    ok: hasRuntimeId && expectedService.endsWith('.service'),
    detail: hasRuntimeId
      ? `service=${expectedService}, runtimeId=${manifest.runtimeId}`
      : `manifest missing runtimeId or invalid service name`
  };
}

function checkThreadPolicy(manifest: EmperorAgentManifest): DoctorCheck {
  const ok = hasRequiredThreadPolicy(manifest.threadPolicy);
  return {
    name: "threadPolicy",
    ok,
    detail: ok
      ? `direct=${manifest.threadPolicy?.direct}, team=${manifest.threadPolicy?.team}, delegation=${manifest.threadPolicy?.delegation}`
      : "manifest is missing the required direct/team/delegation routing policy"
  };
}

function checkBridgeContract(manifest: EmperorAgentManifest): DoctorCheck {
  if (!manifest.bridgeContract) {
    return {
      name: "bridgeContract",
      ok: false,
      detail: "manifest is missing plugin-owned bridge contract metadata"
    };
  }

  const missing = getMissingBridgeCapabilities(manifest.bridgeContract);
  const versionOk = manifest.bridgeContract.version === BRIDGE_CONTRACT_VERSION;
  const transportOk = manifest.bridgeContract.messageTransport?.realtime === "websocket"
    && manifest.bridgeContract.messageTransport?.fallback === "sync";
  const truthOk = manifest.bridgeContract.taskTruth === "claim-note-checkpoint-result";
  const ok = versionOk && transportOk && truthOk && missing.length === 0;

  return {
    name: "bridgeContract",
    ok,
    detail: ok
      ? `version=${manifest.bridgeContract.version}, capabilities=${manifest.bridgeContract.capabilities.length}`
      : `version=${manifest.bridgeContract.version || "missing"}, transport=${JSON.stringify(manifest.bridgeContract.messageTransport || null)}, missingCapabilities=${missing.join(", ") || "none"}, taskTruth=${manifest.bridgeContract.taskTruth || "missing"}`
  };
}

function checkBridgeFreshness(bridgeStatePath: string): DoctorCheck {
  if (!fs.existsSync(bridgeStatePath)) {
    return { name: "bridgeFreshness", ok: false, detail: `${bridgeStatePath} missing` };
  }
  try {
    const updatedMs = readBridgeUpdatedAt(bridgeStatePath);
    if (!updatedMs) {
      return { name: "bridgeFreshness", ok: false, detail: "bridge state has no updatedAt" };
    }
    const ageSec = Math.max(0, Math.round((Date.now() - updatedMs) / 1000));
    return {
      name: "bridgeFreshness",
      ok: ageSec < 600,
      detail: `bridge state updated ${ageSec}s ago`
    };
  } catch (error: any) {
    return { name: "bridgeFreshness", ok: false, detail: `bridge state parse failed: ${error?.message || error}` };
  }
}

function checkPath(name: string, filePath: string): DoctorCheck {
  return {
    name,
    ok: fs.existsSync(filePath),
    detail: fs.existsSync(filePath) ? `${filePath} present` : `${filePath} missing`
  };
}

function resolveRunBridgePath(companionDir: string): string {
  const windowsPath = path.join(companionDir, "run-bridge.ps1");
  if (fs.existsSync(windowsPath)) return windowsPath;
  return path.join(companionDir, "run-bridge.sh");
}

function resolveDoctorApiUrl(paths: EmperorPluginPaths): string {
  const localConfig = loadLocalConfig(paths);
  const envApiUrl = String(process.env.EMPEROR_API_URL || process.env.EMPEROR_CLAW_API_URL || "").trim();
  const configuredApiUrl = String(localConfig?.apiUrl || "").trim();
  return (envApiUrl || configuredApiUrl || DEFAULT_EMPEROR_API_URL).replace(/\/+$/, "");
}

function resolveDoctorToken(): string {
  return String(process.env.EMPEROR_API_TOKEN || process.env.EMPEROR_CLAW_API_TOKEN || "").trim();
}

async function probeEmperorEndpoint(
  url: string,
  token?: string
): Promise<{ reachable: boolean; status: number; detail: string }> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined
    });
    return {
      reachable: true,
      status: response.status,
      detail: `${url} responded ${response.status}`
    };
  } catch (error: any) {
    return {
      reachable: false,
      status: 0,
      detail: `${url} request failed: ${error?.message || error}`
    };
  }
}

async function checkEmperorApiReachability(paths: EmperorPluginPaths): Promise<DoctorCheck> {
  const apiUrl = resolveDoctorApiUrl(paths);
  const probe = await probeEmperorEndpoint(`${apiUrl}/api/mcp/runtime/health`);
  return {
    name: "emperorApiReachability",
    ok: probe.reachable,
    detail: probe.reachable
      ? `${apiUrl} reachable (${probe.status})`
      : probe.detail
  };
}

async function checkEmperorApiAuth(paths: EmperorPluginPaths): Promise<DoctorCheck> {
  const apiUrl = resolveDoctorApiUrl(paths);
  const token = resolveDoctorToken();
  if (!token) {
    return {
      name: "emperorApiAuth",
      ok: false,
      detail: "missing EMPEROR_API_TOKEN or EMPEROR_CLAW_API_TOKEN; authenticated Emperor bootstrap cannot be verified"
    };
  }

  const probe = await probeEmperorEndpoint(`${apiUrl}/api/mcp/agents?limit=1`, token);
  return {
    name: "emperorApiAuth",
    ok: probe.status >= 200 && probe.status < 300,
    detail: probe.status >= 200 && probe.status < 300
      ? `authenticated Emperor API check succeeded (${probe.status})`
      : probe.reachable
        ? `authenticated Emperor API check failed (${probe.status})`
        : probe.detail
  };
}

export async function runDoctor(paths: EmperorPluginPaths): Promise<{ globalChecks: DoctorCheck[]; agents: AgentDoctorReport[] }> {
  const upgradePreview = inspectTrackedManifestUpgrades(paths);
  const manifests = loadManifests(paths);
  const owners = loadThreadOwners(paths);
  const emperorApiReachability = await checkEmperorApiReachability(paths);
  const emperorApiAuth = await checkEmperorApiAuth(paths);
  const globalChecks: DoctorCheck[] = [
    checkPath("manifestRoot", paths.manifestRoot),
    checkPath("stateRoot", paths.stateRoot),
    checkPath("threadOwners", paths.threadOwnerPath),
    checkPath("bridgeAsset", path.join(paths.pluginRoot, "examples", "bridge.js")),
    checkPath("bridgeContractReference", path.join(paths.pluginRoot, "references", "BRIDGE-CONTRACT.md")),
    checkPath("channelManifest", path.join(paths.pluginRoot, "openclaw.plugin.json")),
    checkPath("sessionKeyApi", path.join(paths.pluginRoot, "session-key-api.ts")),
    checkPath("channelConfigReference", path.join(paths.pluginRoot, "references", "CHANNEL-CONFIG.md")),
    emperorApiReachability,
    emperorApiAuth,
    { name: "threadOwnerEntries", ok: true, detail: `${Object.keys(owners).length} tracked direct thread bindings` },
    {
      name: "manifestUpgrades",
      ok: upgradePreview.needingUpgrade === 0,
      detail: upgradePreview.needingUpgrade === 0
        ? "no manifest upgrades are needed"
        : `${upgradePreview.needingUpgrade} manifest(s) should be upgraded with emperor-upgrade-manifests`
    }
  ];

  const agents: AgentDoctorReport[] = [];
  for (const manifest of manifests) {
    const checks: DoctorCheck[] = [
      checkManifestConsistency(manifest),
      checkBridgeContract(manifest),
      checkThreadPolicy(manifest),
      checkPath("companionDir", manifest.companionDir),
      checkPath("envFile", `${manifest.companionDir}/.env`),
      checkPath("runBridge", resolveRunBridgePath(manifest.companionDir)),
      checkPath("bridgeConfig", `${manifest.companionDir}/bridge.config.json`),
      checkPath("runtimeBridge", `${manifest.companionDir}/runtime/bridge.js`),
      checkPath("runtimeControlPlane", `${manifest.companionDir}/runtime/control-plane.js`),
      checkPath("bridgeState", `${manifest.companionDir}/state/bridge-state.json`),
      checkBridgeFreshness(`${manifest.companionDir}/state/bridge-state.json`),
      await checkSystemdService(manifest.serviceName, `${manifest.companionDir}/state/bridge-state.json`),
      { name: "fallbackLog", ok: true, detail: fallbackLogExists(manifest.companionDir) ? `${manifest.companionDir}/bridge-fallback.log present` : `no fallback log present` }
    ];
    agents.push({
      agentName: manifest.agentName,
      serviceName: manifest.serviceName,
      checks
    });
  }

  return { globalChecks, agents };
}

export function formatDoctorReport(report: { globalChecks: DoctorCheck[]; agents: AgentDoctorReport[] }): string {
  const lines: string[] = ["Emperor doctor report:"];
  for (const check of report.globalChecks) {
    lines.push(`- ${check.name}: ${check.ok ? "ok" : "bad"} — ${check.detail}`);
  }
  if (report.agents.length === 0) {
    lines.push("- no tracked agents");
  }
  for (const agent of report.agents) {
    lines.push(`\n[${agent.agentName}]`);
    for (const check of agent.checks) {
      lines.push(`- ${check.name}: ${check.ok ? "ok" : "bad"} — ${check.detail}`);
    }
  }
  return lines.join("\n");
}

export function findBrokenAgents(report: { agents: AgentDoctorReport[] }): AgentDoctorReport[] {
  return report.agents.filter((agent) => agent.checks.some((check) => !check.ok));
}
