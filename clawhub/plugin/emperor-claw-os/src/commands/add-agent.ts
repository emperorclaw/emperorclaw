import type { EmperorPluginPaths } from "../state/paths.js";
import { ensurePluginLayout } from "../state/paths.js";
import { bootstrapAgent } from "../install/bootstrap.js";
import { loadLocalConfig } from "../install/config.js";

export function registerAddAgentCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-add-agent",
    description: "Bootstrap a real Emperor-connected local agent",
    acceptsArgs: true,
    handler: async (ctx: any) => {
      ensurePluginLayout(paths);
      const params = ctx?.args ? JSON.parse(ctx.args) : {};
      const pluginCfg = (api.pluginConfig || {}) as Record<string, string | undefined>;
      const localConfig = loadLocalConfig(paths);
      const result = await bootstrapAgent(paths, {
        apiUrl: String(params.apiUrl || localConfig?.apiUrl || pluginCfg.apiUrl || "https://emperorclaw.malecu.eu"),
        token: String(params.token || ""),
        agentName: String(params.agentName || ""),
        localBrainAgentId: String(params.localBrainAgentId || ""),
        profile: String(params.profile || "operator") as "operator" | "manager",
        ownerName: String(params.ownerName || localConfig?.defaultOwnerName || pluginCfg.defaultOwnerName || "Jose"),
        ownerTimezone: String(params.ownerTimezone || localConfig?.defaultOwnerTimezone || pluginCfg.defaultOwnerTimezone || "UTC"),
        thinking: String(params.thinking || "medium")
      });
      return {
        text: [
          `Bootstrapped Emperor agent ${result.manifest.agentName}.`,
          `Emperor agent id: ${result.manifest.agentId || "unknown"}`,
          `Manifest: ${result.manifestPath}`,
          `Companion dir: ${result.companionDir}`,
          `Service: ${result.manifest.serviceName}`,
          `Shared doctrine resources: ${result.sharedDoctrineResourceIds.length > 0 ? result.sharedDoctrineResourceIds.join(", ") : "not seeded"}`
        ].join("\n")
      };
    }
  });
}
