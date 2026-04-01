import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EmperorPluginPaths } from "../state/paths.js";
import { ensurePluginLayout } from "../state/paths.js";
import { loadManifests } from "../state/manifests.js";

const execFileAsync = promisify(execFile);

export function registerRestartAgentCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-restart-agent",
    description: "Restart a tracked Emperor bridge service by local brain id",
    acceptsArgs: true,
    handler: async (ctx: any) => {
      ensurePluginLayout(paths);
      const params = ctx?.args ? JSON.parse(ctx.args) : {};
      const manifests = loadManifests(paths);
      const manifest = manifests.find((row) => row.localBrainAgentId === String(params.localBrainAgentId || ""));
      if (!manifest) return { text: `No tracked Emperor agent found for ${params.localBrainAgentId}` };
      await execFileAsync("systemctl", ["--user", "restart", manifest.serviceName]);
      return { text: `Restarted ${manifest.serviceName}` };
    }
  });
}
