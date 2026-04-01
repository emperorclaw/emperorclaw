import os from "node:os";
import path from "node:path";
import type { EmperorPluginPaths } from "../state/paths.js";
import { writeManifest } from "../state/manifests.js";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function registerAddAgentCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-add-agent",
    description: "Create a local Emperor agent manifest scaffold",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentName: { type: "string" },
        localBrainAgentId: { type: "string" },
        profile: { type: "string" }
      },
      required: ["agentName", "localBrainAgentId"]
    },
    async execute(_invocationId: string, params: any) {
      const agentName = String(params.agentName);
      const localBrainAgentId = String(params.localBrainAgentId);
      const profile = String(params.profile || "operator");
      const slug = slugify(localBrainAgentId || agentName);
      const companionDir = path.join(os.homedir(), ".openclaw", `emperor-control-plane-${slug}`);
      const manifest = {
        agentName,
        localBrainAgentId,
        runtimeId: `${slug}-${os.hostname().toLowerCase()}`,
        companionDir,
        serviceName: `emperor-claw-bridge-${slug}.service`,
        profile,
        threadPolicy: {
          direct: "bound",
          team: "mention-required"
        },
        installedAt: new Date().toISOString(),
        version: "0.1.0"
      };
      const manifestPath = writeManifest(paths, slug, manifest);
      return {
        content: [{
          type: "text",
          text: [
            `Created Emperor agent manifest scaffold for ${agentName}.`,
            `Manifest: ${manifestPath}`,
            "Next step: wire Emperor API registration, OpenClaw brain creation, runtime files, and service creation into this command."
          ].join("\n")
        }]
      };
    }
  });
}
