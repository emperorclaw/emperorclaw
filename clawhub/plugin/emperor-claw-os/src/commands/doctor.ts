import fs from "node:fs";
import type { EmperorPluginPaths } from "../state/paths.js";
import { loadManifests } from "../state/manifests.js";

export function registerDoctorCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-doctor",
    description: "Run a basic Emperor Claw OS local health check",
    async execute() {
      const manifests = loadManifests(paths);
      const checks = [
        ["manifestRoot", fs.existsSync(paths.manifestRoot)],
        ["stateRoot", fs.existsSync(paths.stateRoot)],
        ["threadOwners", fs.existsSync(paths.threadOwnerPath)]
      ];
      return {
        content: [{
          type: "text",
          text: [
            "Emperor doctor report:",
            ...checks.map(([name, ok]) => `- ${name}: ${ok ? "ok" : "missing"}`),
            `- tracked agent manifests: ${manifests.length}`
          ].join("\n")
        }]
      };
    }
  });
}
