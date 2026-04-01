import type { EmperorPluginPaths } from "../state/paths.js";
import { ensurePluginLayout } from "../state/paths.js";
import { repairAllAgents } from "../install/repair.js";
import { backfillTrackedManifests } from "../state/normalize.js";

export function registerRepairCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-repair",
    description: "Repair and restart tracked Emperor bridge agents",
    handler: async () => {
      ensurePluginLayout(paths);
      const upgraded = backfillTrackedManifests(paths);
      const repaired = await repairAllAgents(paths, api);
      return {
        text: repaired.length === 0 && upgraded.changed === 0
          ? "No tracked Emperor agents were repaired."
          : [
              upgraded.changed > 0
                ? `Backfilled bridge contract metadata for ${upgraded.changed} manifest(s).`
                : "No manifest backfill was needed.",
              repaired.length === 0
                ? "No tracked Emperor agents were repaired."
                : `Repaired Emperor agents:\n${repaired.map((name) => `- ${name}`).join("\n")}`
            ].join("\n")
      };
    }
  });
}
