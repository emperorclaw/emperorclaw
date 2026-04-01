import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EmperorPluginPaths } from "../state/paths.js";
import { loadManifests } from "../state/manifests.js";

const execFileAsync = promisify(execFile);

export function registerRestartAgentCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-restart-agent",
    description: "Restart a tracked Emperor bridge service by local brain id",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        localBrainAgentId: { type: "string" }
      },
      required: ["localBrainAgentId"]
    },
    async execute(_invocationId: string, params: any) {
      const manifests = loadManifests(paths);
      const manifest = manifests.find((row) => row.localBrainAgentId === String(params.localBrainAgentId));
      if (!manifest) {
        return { content: [{ type: "text", text: `No tracked Emperor agent found for ${params.localBrainAgentId}` }] };
      }
      await execFileAsync("systemctl", ["--user", "restart", manifest.serviceName]);
      return { content: [{ type: "text", text: `Restarted ${manifest.serviceName}` }] };
    }
  });
}
