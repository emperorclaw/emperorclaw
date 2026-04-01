import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { registerInstallCommand } from "./src/commands/install.js";
import { registerDoctorCommand } from "./src/commands/doctor.js";
import { registerAddAgentCommand } from "./src/commands/add-agent.js";
import { registerListAgentsCommand } from "./src/commands/list-agents.js";
import { registerStatusCommand } from "./src/commands/status.js";
import { registerRepairCommand } from "./src/commands/repair.js";
import { registerRebindThreadsCommand } from "./src/commands/rebind-threads.js";
import { registerRestartAgentCommand } from "./src/commands/restart-agent.js";
import { registerRemoveAgentCommand } from "./src/commands/remove-agent.js";
import { ensurePluginLayout, resolvePluginPaths } from "./src/state/paths.js";

export default definePluginEntry({
  id: "emperor-claw-os",
  name: "Emperor Claw OS",
  description: "Install, repair, and manage Emperor-connected OpenClaw bridge agents.",
  configSchema: Type.Object({
    apiUrl: Type.Optional(Type.String()),
    defaultOwnerName: Type.Optional(Type.String()),
    defaultOwnerTimezone: Type.Optional(Type.String()),
    manifestRoot: Type.Optional(Type.String()),
    stateRoot: Type.Optional(Type.String())
  }, { additionalProperties: false }),
  register(api) {
    const paths = resolvePluginPaths(api);
    ensurePluginLayout(paths);

    api.registerCommand({
      name: "emperor-status",
      description: "Show current Emperor Claw OS plugin status",
      async execute() {
        const manifests = loadManifests(paths);
        return {
          content: [{
            type: "text",
            text: [
              "Emperor Claw OS plugin is installed.",
              `Manifest root: ${paths.manifestRoot}`,
              `State root: ${paths.stateRoot}`,
              `Tracked agents: ${manifests.length}`
            ].join("\n")
          }]
        };
      }
    });

    registerStatusCommand(api, paths);
    registerInstallCommand(api, paths);
    registerDoctorCommand(api, paths);
    registerAddAgentCommand(api, paths);
    registerListAgentsCommand(api, paths);
    registerRepairCommand(api, paths);
    registerRebindThreadsCommand(api, paths);
    registerRestartAgentCommand(api, paths);
    registerRemoveAgentCommand(api, paths);

    api.registerService({
      name: "emperor-claw-os-supervisor",
      async start() {
        api.logger.info("Emperor Claw OS supervisor started", { manifestRoot: paths.manifestRoot });
        return {
          stop: async () => {
            api.logger.info("Emperor Claw OS supervisor stopped");
          }
        };
      }
    });
  }
});
