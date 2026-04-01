import type { EmperorPluginPaths } from "../state/paths.js";
import { bootstrapAgent } from "../install/bootstrap.js";

export function registerAddAgentCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-add-agent",
    description: "Bootstrap a real Emperor-connected local agent",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentName: { type: "string" },
        localBrainAgentId: { type: "string" },
        profile: { type: "string" },
        apiUrl: { type: "string" },
        token: { type: "string" },
        ownerName: { type: "string" },
        ownerTimezone: { type: "string" },
        thinking: { type: "string" }
      },
      required: ["agentName", "localBrainAgentId", "token"]
    },
    async execute(_invocationId: string, params: any) {
      const pluginCfg = (api.pluginConfig || {}) as Record<string, string | undefined>;
      const result = await bootstrapAgent(paths, {
        apiUrl: String(params.apiUrl || pluginCfg.apiUrl || "https://emperorclaw.malecu.eu"),
        token: String(params.token),
        agentName: String(params.agentName),
        localBrainAgentId: String(params.localBrainAgentId),
        profile: String(params.profile || "operator") as "operator" | "manager",
        ownerName: String(params.ownerName || pluginCfg.defaultOwnerName || "Jose"),
        ownerTimezone: String(params.ownerTimezone || pluginCfg.defaultOwnerTimezone || "UTC"),
        thinking: String(params.thinking || "medium")
      });
      return {
        content: [{
          type: "text",
          text: [
            `Bootstrapped Emperor agent ${result.manifest.agentName}.`,
            `Manifest: ${result.manifestPath}`,
            `Companion dir: ${result.companionDir}`,
            `Service: ${result.manifest.serviceName}`
          ].join("\n")
        }]
      };
    }
  });
}
