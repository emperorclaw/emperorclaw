import type { EmperorPluginPaths } from "../state/paths.js";

export function registerInstallCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-install",
    description: "Initialize Emperor Claw OS local plugin state",
    async execute() {
      return {
        content: [{
          type: "text",
          text: [
            "Emperor plugin install scaffold completed.",
            `Manifest root: ${paths.manifestRoot}`,
            `State root: ${paths.stateRoot}`,
            "Next step: wire full add-agent bootstrap, doctor, repair, and runtime supervision into this plugin."
          ].join("\n")
        }]
      };
    }
  });
}
