import type { EmperorPluginPaths } from "../state/paths.js";
import { ensurePluginLayout } from "../state/paths.js";
import { writeLocalConfig } from "../install/config.js";

export function registerInstallCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-install",
    description: "Initialize Emperor Claw OS plugin config and local state",
    acceptsArgs: true,
    handler: async (ctx: any) => {
      ensurePluginLayout(paths);
      const params = ctx?.args ? JSON.parse(ctx.args) : {};
      const configPath = writeLocalConfig(paths, {
        apiUrl: String(params.apiUrl || api.pluginConfig?.apiUrl || "https://emperorclaw.malecu.eu"),
        defaultOwnerName: String(params.defaultOwnerName || api.pluginConfig?.defaultOwnerName || "Jose"),
        defaultOwnerTimezone: String(params.defaultOwnerTimezone || api.pluginConfig?.defaultOwnerTimezone || "UTC"),
        installedAt: new Date().toISOString()
      });
      return {
        text: [
          "Emperor plugin install initialized.",
          `Config: ${configPath}`,
          `Manifest root: ${paths.manifestRoot}`,
          `State root: ${paths.stateRoot}`,
          "Next step: run emperor-add-agent with a token to create the first real bridge-backed agent."
        ].join("\n")
      };
    }
  });
}
