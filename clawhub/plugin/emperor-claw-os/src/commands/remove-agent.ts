import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EmperorPluginPaths } from "../state/paths.js";
import { ensurePluginLayout } from "../state/paths.js";
import { loadManifests, resolveManifestPath } from "../state/manifests.js";
import { loadThreadOwners, saveThreadOwners } from "../state/thread-owners.js";

const execFileAsync = promisify(execFile);

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
    acceptsArgs: true,
    handler: async (ctx: any) => {
      ensurePluginLayout(paths);
      const params = ctx?.args ? JSON.parse(ctx.args) : {};
      const localBrainAgentId = String(params.localBrainAgentId || "");
      const removeCompanionDir = Boolean(params.removeCompanionDir || false);
      const manifests = loadManifests(paths);
      const manifest = manifests.find((row) => row.localBrainAgentId === localBrainAgentId);
      if (!manifest) return { text: `No tracked Emperor agent found for ${localBrainAgentId}` };
      try { await execFileAsync("systemctl", ["--user", "disable", "--now", manifest.serviceName]); } catch {}
      const manifestPath = resolveManifestPath(paths, localBrainAgentId);
      if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
      let companionRemoved = false;
      if (removeCompanionDir && fs.existsSync(manifest.companionDir)) {
        fs.rmSync(manifest.companionDir, { recursive: true, force: true });
        companionRemoved = true;
      }
      const threadBindingsRemoved = removeMatchingThreadOwners(paths, manifest.agentId);
      return {
        text: [
          `Removed tracked Emperor agent ${localBrainAgentId}`,
          `Manifest removed: ${manifestPath}`,
          `Thread bindings removed: ${threadBindingsRemoved}`,
          `Companion dir removed: ${companionRemoved ? "yes" : "no"}`
        ].join("\n")
      };
    }
  });
}
