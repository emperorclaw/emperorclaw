import type { EmperorPluginPaths } from "./paths.js";
import { createDefaultBridgeContract, DEFAULT_THREAD_POLICY, getMissingBridgeCapabilities, hasRequiredThreadPolicy } from "../bridge/contract.js";
import { loadManifests, slugifyManifestId, writeManifest, type EmperorAgentManifest } from "./manifests.js";

function normalizeManifest(manifest: EmperorAgentManifest): { manifest: EmperorAgentManifest; changed: boolean } {
  let changed = false;
  const next: EmperorAgentManifest = { ...manifest };

  if (!hasRequiredThreadPolicy(next.threadPolicy)) {
    next.threadPolicy = { ...DEFAULT_THREAD_POLICY };
    changed = true;
  }

  if (!next.bridgeContract || getMissingBridgeCapabilities(next.bridgeContract).length > 0) {
    next.bridgeContract = createDefaultBridgeContract();
    changed = true;
  }

  return { manifest: next, changed };
}

export function inspectTrackedManifestUpgrades(paths: EmperorPluginPaths): { scanned: number; needingUpgrade: number; agents: string[] } {
  const manifests = loadManifests(paths);
  const agents: string[] = [];
  let needingUpgrade = 0;

  for (const manifest of manifests) {
    const normalized = normalizeManifest(manifest);
    if (!normalized.changed) continue;
    needingUpgrade += 1;
    agents.push(manifest.agentName);
  }

  return {
    scanned: manifests.length,
    needingUpgrade,
    agents
  };
}

export function backfillTrackedManifests(paths: EmperorPluginPaths): { scanned: number; changed: number; agents: string[] } {
  const manifests = loadManifests(paths);
  const agents: string[] = [];
  let changed = 0;

  for (const manifest of manifests) {
    const normalized = normalizeManifest(manifest);
    if (!normalized.changed) continue;
    writeManifest(paths, slugifyManifestId(manifest.localBrainAgentId), normalized.manifest);
    changed += 1;
    agents.push(manifest.agentName);
  }

  return {
    scanned: manifests.length,
    changed,
    agents
  };
}
