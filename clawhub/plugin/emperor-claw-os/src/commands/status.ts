import fs from "node:fs";
import type { EmperorPluginPaths } from "../state/paths.js";
import { loadLocalConfig } from "../install/config.js";
import { loadManifests } from "../state/manifests.js";
import { loadThreadOwners } from "../state/thread-owners.js";

export function registerStatusCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-status",
    description: "Show Emperor Claw OS plugin status summary",
    async execute() {
      const localConfig = loadLocalConfig(paths);
      const manifests = loadManifests(paths);
      const owners = loadThreadOwners(paths);
      const summary = {
        pluginId: api.id,
        rootDir: api.rootDir || "unknown",
        localConfigPresent: Boolean(localConfig),
        manifestCount: manifests.length,
        threadOwnerCount: Object.keys(owners).length,
        hasBridgeAsset: fs.existsSync(`${process.cwd()}/examples/bridge.js`),
        hasDoctorScript: fs.existsSync(`${process.cwd()}/scripts/doctor-local.sh`)
      };
      return {
        content: [{
          type: "text",
          text: JSON.stringify(summary, null, 2)
        }]
      };
    }
  });
}
