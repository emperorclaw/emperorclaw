import type { EmperorPluginPaths } from "../state/paths.js";
import { ensurePluginLayout } from "../state/paths.js";
import { loadManifests } from "../state/manifests.js";
import { reloadAndRestartService, startFallbackBridge } from "../runtime/services.js";

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
      const restarted = await reloadAndRestartService(manifest.serviceName.replace(/\.service$/, ""));
      if (restarted.mode === "fallback") {
        const logPath = await startFallbackBridge(manifest.companionDir);
        return { text: `Restarted ${manifest.serviceName} via fallback launcher (${logPath})` };
      }
      return { text: restarted.detail };
    }
  });
}
