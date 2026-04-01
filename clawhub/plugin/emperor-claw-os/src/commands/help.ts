import type { EmperorPluginPaths } from "../state/paths.js";

export function registerHelpCommand(api: any, _paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-help",
    description: "Show Emperor Claw OS plugin command overview",
    async execute() {
      return {
        content: [{
          type: "text",
          text: [
            "Emperor Claw OS plugin commands:",
            "- emperor-status — plugin status summary",
            "- emperor-install — initialize local plugin config",
            "- emperor-add-agent — bootstrap a bridge-backed local agent",
            "- emperor-list-agents — list tracked manifests",
            "- emperor-doctor — health diagnostics",
            "- emperor-repair — re-bootstrap and restart tracked agents",
            "- emperor-rebind-threads — rebuild direct-thread ownership state",
            "- emperor-restart-agent — restart one tracked bridge service",
            "- emperor-remove-agent — remove one tracked agent manifest/service",
            "- emperor-help — this help overview"
          ].join("\n")
        }]
      };
    }
  });
}
