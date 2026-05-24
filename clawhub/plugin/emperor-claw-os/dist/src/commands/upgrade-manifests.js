import { ensurePluginLayout } from "../state/paths.js";
import { backfillTrackedManifests } from "../state/normalize.js";
export function registerUpgradeManifestsCommand(api, paths) {
    api.registerCommand({
        name: "emperor-upgrade-manifests",
        description: "Backfill tracked manifests with required bridge contract metadata",
        handler: async () => {
            ensurePluginLayout(paths);
            const result = backfillTrackedManifests(paths);
            return {
                text: result.changed === 0
                    ? `Scanned ${result.scanned} manifests. No manifest upgrades were needed.`
                    : [
                        `Scanned ${result.scanned} manifests.`,
                        `Upgraded ${result.changed} manifest(s) with bridge contract metadata:`,
                        ...result.agents.map((agentName) => `- ${agentName}`)
                    ].join("\n")
            };
        }
    });
}
