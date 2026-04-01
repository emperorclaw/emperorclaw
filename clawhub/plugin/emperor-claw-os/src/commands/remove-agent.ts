import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EmperorPluginPaths } from "../state/paths.js";
import { loadManifests } from "../state/manifests.js";
import { loadThreadOwners, saveThreadOwners } from "../state/thread-owners.js";

const execFileAsync = promisify(execFile);

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function removeMatchingThreadOwners(paths: EmperorPluginPaths, emperorAgentId?: string): number {
  if (!emperorAgentId) return 0;
  const owners = loadThreadOwners(paths);
  let removed = 0;
  for (const [threadId, ownerId] of Object.entries(owners)) {
    if (ownerId === emperorAgentId) {
      delete owners[threadId];
      removed += 1;
    }
  }
  saveThreadOwners(paths, owners);
  return removed;
}

export function registerRemoveAgentCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-remove-agent",
    description: "Remove a tracked Emperor agent manifest and stop its service",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        localBrainAgentId: { type: "string" },
        removeCompanionDir: { type: "boolean" }
      },
      required: ["localBrainAgentId"]
    },
    async execute(_invocationId: string, params: any) {
      const localBrainAgentId = String(params.localBrainAgentId);
      const removeCompanionDir = Boolean(params.removeCompanionDir || false);
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
      let companionRemoved = false;
      if (removeCompanionDir && fs.existsSync(manifest.companionDir)) {
        fs.rmSync(manifest.companionDir, { recursive: true, force: true });
        companionRemoved = true;
      }
      const threadBindingsRemoved = removeMatchingThreadOwners(paths, manifest.agentId);
      return {
        content: [{
          type: "text",
          text: [
            `Removed tracked Emperor agent ${localBrainAgentId}`,
            `Manifest removed: ${manifestPath}`,
            `Thread bindings removed: ${threadBindingsRemoved}`,
            `Companion dir removed: ${companionRemoved ? "yes" : "no"}`
          ].join("\n")
        }]
      };
    }
  });
}
