import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EmperorPluginPaths } from "../state/paths.js";
import { loadManifests } from "../state/manifests.js";
import { bootstrapAgent } from "./bootstrap.js";

const execFileAsync = promisify(execFile);

function parseEnvValue(rawValue: string): string {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : String(parsed ?? "");
  } catch {
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }
}

export async function repairAllAgents(paths: EmperorPluginPaths, api: any): Promise<string[]> {
  const manifests = loadManifests(paths);
  const repaired: string[] = [];
  const pluginConfig = api?.pluginConfig || {};
  const defaultApiUrl = String(pluginConfig.apiUrl || "http://localhost:3000");
  const defaultToken = String(
    pluginConfig.apiToken
    || pluginConfig.token
    || pluginConfig.emperorToken
    || "",
  );
  const defaultOwnerName = String(pluginConfig.defaultOwnerName || "Admin");
  const defaultOwnerTimezone = String(pluginConfig.defaultOwnerTimezone || "UTC");
  for (const manifest of manifests) {
    const envFile = `${manifest.companionDir}/.env`;
    const vars = fs.existsSync(envFile)
      ? Object.fromEntries(
          fs.readFileSync(envFile, "utf8").split(/\n+/).filter(Boolean).map((line) => {
            const idx = line.indexOf("=");
            const key = line.slice(0, idx);
            const value = parseEnvValue(line.slice(idx + 1));
            return [key, value];
          }),
        )
      : {};

    const token = String(vars.EMPEROR_CLAW_API_TOKEN || defaultToken || "").trim();
    if (!token) continue;

    await bootstrapAgent(paths, {
      apiUrl: String(vars.EMPEROR_CLAW_API_URL || defaultApiUrl),
      token,
      agentName: String(vars.EMPEROR_CLAW_AGENT_NAME || manifest.agentName),
      localBrainAgentId: String(vars.EMPEROR_CLAW_BRAIN_AGENT_ID || manifest.localBrainAgentId),
      profile: String(vars.EMPEROR_CLAW_AGENT_PROFILE || manifest.profile || "operator") as "operator" | "manager",
      ownerName: defaultOwnerName,
      ownerTimezone: defaultOwnerTimezone,
      thinking: String(vars.EMPEROR_CLAW_BRAIN_THINKING || "medium"),
    });
    repaired.push(manifest.agentName);
  }
  return repaired;
}
