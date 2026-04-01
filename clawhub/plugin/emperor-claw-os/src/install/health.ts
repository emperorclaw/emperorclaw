import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EmperorPluginPaths } from "../state/paths.js";
import { loadManifests, type EmperorAgentManifest } from "../state/manifests.js";
import { loadThreadOwners } from "../state/thread-owners.js";
import { serviceIsActive, fallbackLogExists } from "../runtime/services.js";

const execFileAsync = promisify(execFile);

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

async function checkSystemdService(serviceName: string): Promise<DoctorCheck> {
  const active = await serviceIsActive(serviceName);
  return { name: "service", ok: active, detail: active ? `${serviceName} active` : `${serviceName} inactive or unavailable` };
}

function checkPath(name: string, filePath: string): DoctorCheck {
  return {
    name,
    ok: fs.existsSync(filePath),
    detail: fs.existsSync(filePath) ? `${filePath} present` : `${filePath} missing`
  };
}

export async function runDoctor(paths: EmperorPluginPaths): Promise<{ globalChecks: DoctorCheck[]; agents: AgentDoctorReport[] }> {
  const manifests = loadManifests(paths);
  const owners = loadThreadOwners(paths);
  const globalChecks: DoctorCheck[] = [
    checkPath("manifestRoot", paths.manifestRoot),
    checkPath("stateRoot", paths.stateRoot),
    checkPath("threadOwners", paths.threadOwnerPath),
    { name: "threadOwnerEntries", ok: true, detail: `${Object.keys(owners).length} tracked direct thread bindings` }
  ];

  const agents: AgentDoctorReport[] = [];
  for (const manifest of manifests) {
    const checks: DoctorCheck[] = [
      checkPath("companionDir", manifest.companionDir),
      checkPath("envFile", `${manifest.companionDir}/.env`),
      checkPath("runBridge", `${manifest.companionDir}/run-bridge.sh`),
      checkPath("bridgeConfig", `${manifest.companionDir}/bridge.config.json`),
      checkPath("runtimeBridge", `${manifest.companionDir}/runtime/bridge.js`),
      checkPath("runtimeControlPlane", `${manifest.companionDir}/runtime/control-plane.js`),
      checkPath("bridgeState", `${manifest.companionDir}/state/bridge-state.json`),
      await checkSystemdService(manifest.serviceName),
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
