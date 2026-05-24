import { createDefaultBridgeContract, DEFAULT_THREAD_POLICY, getMissingBridgeCapabilities, hasRequiredThreadPolicy } from "../bridge/contract.js";
import { loadManifests, slugifyManifestId, writeManifest } from "./manifests.js";
function normalizeManifest(manifest) {
    let changed = false;
    const next = { ...manifest };
    if (!hasRequiredThreadPolicy(next.threadPolicy)) {
        next.threadPolicy = { ...DEFAULT_THREAD_POLICY };
        changed = true;
    }
    if (!next.bridgeContract || getMissingBridgeCapabilities(next.bridgeContract).length > 0) {
        next.bridgeContract = createDefaultBridgeContract();
        changed = true;
    }
    if ((!Array.isArray(next.sharedDoctrineResourceIds) || next.sharedDoctrineResourceIds.length === 0) && next.doctrineResourceId) {
        next.sharedDoctrineResourceIds = [String(next.doctrineResourceId)];
        changed = true;
    }
    return { manifest: next, changed };
}
export function inspectTrackedManifestUpgrades(paths) {
    const manifests = loadManifests(paths);
    const agents = [];
    let needingUpgrade = 0;
    for (const manifest of manifests) {
        const normalized = normalizeManifest(manifest);
        if (!normalized.changed)
            continue;
        needingUpgrade += 1;
        agents.push(manifest.agentName);
    }
    return {
        scanned: manifests.length,
        needingUpgrade,
        agents
    };
}
export function backfillTrackedManifests(paths) {
    const manifests = loadManifests(paths);
    const agents = [];
    let changed = 0;
    for (const manifest of manifests) {
        const normalized = normalizeManifest(manifest);
        if (!normalized.changed)
            continue;
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
