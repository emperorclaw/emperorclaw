import fs from "node:fs";
import type { EmperorPluginPaths } from "../state/paths.js";
import { ensurePluginLayout } from "../state/paths.js";
import { loadLocalConfig } from "../install/config.js";
import { loadManifests } from "../state/manifests.js";
import { loadThreadOwners } from "../state/thread-owners.js";
import { BRIDGE_CONTRACT_VERSION, REQUIRED_BRIDGE_CAPABILITIES } from "../bridge/contract.js";
import { inspectTrackedManifestUpgrades } from "../state/normalize.js";
import { inspectOpenClawProfileConfig, resolveOpenClawConfigPath } from "../install/openclaw-profile.js";

export function registerStatusCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-status",
    description: "Show Emperor Claw OS plugin status summary",
    handler: async () => {
      ensurePluginLayout(paths);
      const localConfig = loadLocalConfig(paths);
      const manifests = loadManifests(paths);
      const owners = loadThreadOwners(paths);
      const upgradePreview = inspectTrackedManifestUpgrades(paths);
      const openclawProfileConfig = inspectOpenClawProfileConfig(resolveOpenClawConfigPath(paths.pluginRoot));
      const summary = {
        pluginId: api.id,
        rootDir: api.rootDir || "unknown",
        localConfigPresent: Boolean(localConfig),
        configuredApiUrl: localConfig?.apiUrl || "https://emperorclaw.malecu.eu",
        emperorTokenPresent: Boolean(process.env.EMPEROR_API_TOKEN || process.env.EMPEROR_CLAW_API_TOKEN),
        bridgeContractVersion: BRIDGE_CONTRACT_VERSION,
        requiredBridgeCapabilities: REQUIRED_BRIDGE_CAPABILITIES,
        manifestCount: manifests.length,
        manifestsWithBridgeContract: manifests.filter((manifest) => Boolean(manifest.bridgeContract)).length,
        manifestsWithSharedDoctrineResources: manifests.filter((manifest) => {
          const ids = Array.isArray(manifest.sharedDoctrineResourceIds)
            ? manifest.sharedDoctrineResourceIds.filter(Boolean)
            : [];
          return ids.length >= 2 || Boolean(manifest.doctrineResourceId);
        }).length,
        manifestsNeedingUpgrade: upgradePreview.needingUpgrade,
        threadOwnerCount: Object.keys(owners).length,
        hasBridgeAsset: fs.existsSync(`${paths.pluginRoot}/examples/bridge.js`),
        hasDoctorScript: fs.existsSync(`${paths.pluginRoot}/scripts/doctor-local.sh`),
        declaresChannelInManifest: fs.readFileSync(`${paths.pluginRoot}/openclaw.plugin.json`, "utf8").includes("\"channels\""),
        hasSessionKeyApi: fs.existsSync(`${paths.pluginRoot}/session-key-api.ts`),
        hasChannelConfigReference: fs.existsSync(`${paths.pluginRoot}/references/CHANNEL-CONFIG.md`),
        openclawProfileConfigPath: resolveOpenClawConfigPath(paths.pluginRoot),
        openclawPluginAllowed: openclawProfileConfig.pluginAllowed,
        openclawPluginEnabled: openclawProfileConfig.pluginEnabled,
        openclawSandboxMode: openclawProfileConfig.sandboxMode || null
      };
      return { text: JSON.stringify(summary, null, 2) };
    }
  });
}
