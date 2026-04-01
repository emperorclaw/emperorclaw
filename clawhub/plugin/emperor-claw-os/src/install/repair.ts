import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EmperorPluginPaths } from "../state/paths.js";
import { loadManifests } from "../state/manifests.js";
import { bootstrapAgent } from "./bootstrap.js";
import { reloadAndRestartService, startFallbackBridge } from "../runtime/services.js";

const execFileAsync = promisify(execFile);

export async function repairAllAgents(paths: EmperorPluginPaths, api: any): Promise<string[]> {
  const manifests = loadManifests(paths);
  const repaired: string[] = [];
  for (const manifest of manifests) {
    const envFile = `${manifest.companionDir}/.env`;
    if (!fs.existsSync(envFile)) continue;
    const envText = fs.readFileSync(envFile, "utf8");
    const vars = Object.fromEntries(
      envText.split(/\n+/).filter(Boolean).map((line) => {
        const idx = line.indexOf("=");
        const key = line.slice(0, idx);
        let value = line.slice(idx + 1);
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return [key, value];
      })
    );

    await bootstrapAgent(paths, {
      apiUrl: String(vars.EMPEROR_CLAW_API_URL || api.pluginConfig?.apiUrl || "https://emperorclaw.malecu.eu"),
      token: String(vars.EMPEROR_CLAW_API_TOKEN || ""),
      agentName: String(vars.EMPEROR_CLAW_AGENT_NAME || manifest.agentName),
      localBrainAgentId: String(vars.EMPEROR_CLAW_BRAIN_AGENT_ID || manifest.localBrainAgentId),
      profile: String(vars.EMPEROR_CLAW_AGENT_PROFILE || manifest.profile || "operator") as "operator" | "manager",
      ownerName: String(api.pluginConfig?.defaultOwnerName || "Jose"),
      ownerTimezone: String(api.pluginConfig?.defaultOwnerTimezone || "UTC"),
      thinking: String(vars.EMPEROR_CLAW_BRAIN_THINKING || "medium")
    });

    const restarted = await reloadAndRestartService(manifest.serviceName.replace(/\.service$/, ""));
    if (restarted.mode === "fallback") {
      await startFallbackBridge(manifest.companionDir);
    }
    repaired.push(manifest.agentName);
  }
  return repaired;
}
