import fs from "node:fs";
import path from "node:path";
import type { EmperorPluginPaths } from "./paths.js";
import type { EmperorBridgeContract, EmperorThreadPolicy } from "../bridge/contract.js";

export type EmperorAgentManifest = {
  agentId?: string;
  agentName: string;
  localBrainAgentId: string;
  runtimeId: string;
  companionDir: string;
  serviceName: string;
  profile: string;
  sharedDoctrineResourceIds?: string[];
  doctrineResourceId?: string | null;
  threadPolicy?: EmperorThreadPolicy;
  bridgeContract?: EmperorBridgeContract;
  installedAt: string;
  version: string;
};

function manifestPath(paths: EmperorPluginPaths, slug: string): string {
  return path.join(paths.manifestRoot, `${slug}.json`);
}

export function slugifyManifestId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function loadManifests(paths: EmperorPluginPaths): EmperorAgentManifest[] {
  if (!fs.existsSync(paths.manifestRoot)) return [];
  return fs.readdirSync(paths.manifestRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(paths.manifestRoot, name))
    .map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")) as EmperorAgentManifest);
}

export function writeManifest(paths: EmperorPluginPaths, slug: string, manifest: EmperorAgentManifest): string {
  const filePath = manifestPath(paths, slug);
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return filePath;
}

export function resolveManifestPath(paths: EmperorPluginPaths, localBrainAgentId: string): string {
  return manifestPath(paths, slugifyManifestId(localBrainAgentId));
}
