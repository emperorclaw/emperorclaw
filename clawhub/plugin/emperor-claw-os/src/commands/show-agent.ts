import type { EmperorPluginPaths } from "../state/paths.js";
import { loadManifests } from "../state/manifests.js";

export function registerShowAgentCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-show-agent",
    description: "Show one tracked Emperor agent manifest",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        localBrainAgentId: { type: "string" }
      },
      required: ["localBrainAgentId"]
    },
    async execute(_invocationId: string, params: any) {
      const target = String(params.localBrainAgentId);
      const manifest = loadManifests(paths).find((row) => row.localBrainAgentId === target);
      if (!manifest) {
        return {
          content: [{ type: "text", text: `No tracked Emperor agent found for ${target}` }]
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(manifest, null, 2) }]
      };
    }
  });
}
