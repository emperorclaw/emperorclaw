import type { EmperorPluginPaths } from "../state/paths.js";

export function registerHelpCommand(api: any, _paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-help",
    description: "Show Emperor Claw OS plugin command overview",
    handler: async () => ({
      text: [
        "Emperor Claw OS plugin commands:",
        "- emperor-status - plugin status summary",
        "- emperor-install - initialize local plugin config",
        "- emperor-add-agent - bootstrap a bridge-backed local agent",
        "- emperor-list-agents - list tracked manifests",
        "- emperor-show-agent - show one tracked manifest in detail",
        "- emperor-doctor - health diagnostics",
        "- emperor-upgrade-manifests - backfill legacy manifests with bridge contract metadata",
        "- emperor-repair - re-bootstrap and restart tracked agents",
        "- emperor-rebind-threads - rebuild direct-thread ownership state",
        "- emperor-restart-agent - restart one tracked bridge service",
        "- emperor-remove-agent - remove one tracked agent manifest/service and optionally delete companion dir, workspace, and local brain agent",
        "- emperor-doctor also checks Emperor host reachability and authenticated API readiness when an EMPEROR_API_TOKEN is present",
        "- emperor-channel runtime metadata is registered through index.ts",
        "- emperor-help - this help overview"
      ].join("\n")
    })
  });
}
