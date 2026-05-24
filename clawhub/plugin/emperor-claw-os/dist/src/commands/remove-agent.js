import { ensurePluginLayout } from "../state/paths.js";
import { removeTrackedAgent } from "../install/remove.js";
export function registerRemoveAgentCommand(api, paths) {
    api.registerCommand({
        name: "emperor-remove-agent",
        description: "Remove a tracked Emperor agent manifest and stop its service",
        acceptsArgs: true,
        handler: async (ctx) => {
            ensurePluginLayout(paths);
            const params = ctx?.args ? JSON.parse(ctx.args) : {};
            const localBrainAgentId = String(params.localBrainAgentId || "");
            const removeCompanionDir = Boolean(params.removeCompanionDir || false);
            const removeWorkspace = Boolean(params.removeWorkspace || false);
            const removeLocalBrain = Boolean(params.removeLocalBrainAgent || false);
            const result = await removeTrackedAgent(paths, {
                localBrainAgentId,
                removeCompanionDir,
                removeWorkspace,
                removeLocalBrainAgent: removeLocalBrain
            });
            if (!result)
                return { text: `No tracked Emperor agent found for ${localBrainAgentId}` };
            return {
                text: [
                    `Removed tracked Emperor agent ${result.localBrainAgentId}`,
                    `Manifest removed: ${result.manifestPath}`,
                    `Thread bindings removed: ${result.threadBindingsRemoved}`,
                    `Systemd unit removed: ${result.systemdUnitRemoved ? "yes" : "no"}`,
                    `Companion dir removed: ${result.companionRemoved ? "yes" : "no"}`,
                    `Workspace removed: ${result.workspaceRemoved ? "yes" : "no"}`,
                    `Local brain agent removed: ${result.localBrainAgentRemovalAttempted ? (result.localBrainAgentRemoved ? "yes" : "no") : "skipped"}`
                ].join("\n")
            };
        }
    });
}
