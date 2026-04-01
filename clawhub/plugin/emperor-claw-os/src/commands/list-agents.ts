import type { EmperorPluginPaths } from "../state/paths.js";
import { loadManifests } from "../state/manifests.js";

export function registerListAgentsCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-list-agents",
    description: "List locally tracked Emperor agent manifests",
    async execute() {
      const manifests = loadManifests(paths);
      return {
        content: [{
          type: "text",
          text: manifests.length === 0
            ? "No Emperor agent manifests are currently tracked."
            : manifests.map((manifest) => `- ${manifest.agentName} → ${manifest.localBrainAgentId} (${manifest.serviceName})`).join("\n")
        }]
      };
    }
  });
}
