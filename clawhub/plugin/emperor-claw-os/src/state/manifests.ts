import fs from "node:fs";
import path from "node:path";
import type { EmperorPluginPaths } from "./paths.js";

export type EmperorAgentManifest = {
  agentId?: string;
  agentName: string;
  localBrainAgentId: string;
  runtimeId: string;
  companionDir: string;
  serviceName: string;
  profile: string;
  threadPolicy: {
    direct: string;
    team: string;
  };
  installedAt: string;
  version: string;
};

export function loadManifests(paths: EmperorPluginPaths): EmperorAgentManifest[] {
  if (!fs.existsSync(paths.manifestRoot)) return [];
  return fs.readdirSync(paths.manifestRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(paths.manifestRoot, name))
    .map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")) as EmperorAgentManifest);
}

export function writeManifest(paths: EmperorPluginPaths, slug: string, manifest: EmperorAgentManifest): string {
  const filePath = path.join(paths.manifestRoot, `${slug}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return filePath;
}
