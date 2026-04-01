import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EmperorPluginPaths } from "../state/paths.js";
import { loadManifests } from "../state/manifests.js";

const execFileAsync = promisify(execFile);

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function registerRemoveAgentCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-remove-agent",
    description: "Remove a tracked Emperor agent manifest and stop its service",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        localBrainAgentId: { type: "string" }
      },
      required: ["localBrainAgentId"]
    },
    async execute(_invocationId: string, params: any) {
      const localBrainAgentId = String(params.localBrainAgentId);
      const manifests = loadManifests(paths);
      const manifest = manifests.find((row) => row.localBrainAgentId === localBrainAgentId);
      if (!manifest) {
        return { content: [{ type: "text", text: `No tracked Emperor agent found for ${localBrainAgentId}` }] };
      }
      try {
        await execFileAsync("systemctl", ["--user", "disable", "--now", manifest.serviceName]);
      } catch {
        // best effort
      }
      const manifestPath = path.join(paths.manifestRoot, `${slugify(localBrainAgentId)}.json`);
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
      }
      return { content: [{ type: "text", text: `Removed tracked Emperor agent ${localBrainAgentId}` }] };
    }
  });
}
