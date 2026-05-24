import { ensurePluginLayout } from "../state/paths.js";
import { loadManifests } from "../state/manifests.js";
export function registerShowAgentCommand(api, paths) {
    api.registerCommand({
        name: "emperor-show-agent",
        description: "Show one tracked Emperor agent manifest",
        acceptsArgs: true,
        handler: async (ctx) => {
            ensurePluginLayout(paths);
            const params = ctx?.args ? JSON.parse(ctx.args) : {};
            const target = String(params.localBrainAgentId || "");
            const manifest = loadManifests(paths).find((row) => row.localBrainAgentId === target);
            if (!manifest)
                return { text: `No tracked Emperor agent found for ${target}` };
            return {
                text: [
                    `Agent: ${manifest.agentName}`,
                    `Local brain: ${manifest.localBrainAgentId}`,
                    `Emperor agent id: ${manifest.agentId || "unknown"}`,
                    `Service: ${manifest.serviceName}`,
                    `Companion dir: ${manifest.companionDir}`,
                    `Runtime id: ${manifest.runtimeId}`,
                    `Profile: ${manifest.profile}`,
                    `Shared doctrine resources: ${(manifest.sharedDoctrineResourceIds || []).length > 0 ? manifest.sharedDoctrineResourceIds.join(", ") : (manifest.doctrineResourceId || "missing")}`,
                    `Bridge contract version: ${manifest.bridgeContract?.version || "missing"}`,
                    `Thread policy: direct=${manifest.threadPolicy?.direct || "missing"}, team=${manifest.threadPolicy?.team || "missing"}, delegation=${manifest.threadPolicy?.delegation || "missing"}`,
                    `Installed at: ${manifest.installedAt}`,
                    "",
                    JSON.stringify(manifest, null, 2)
                ].join("\n")
            };
        }
    });
}
