import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { registerInstallCommand } from "./src/commands/install.js";
import { registerDoctorCommand } from "./src/commands/doctor.js";
import { registerAddAgentCommand } from "./src/commands/add-agent.js";
import { registerListAgentsCommand } from "./src/commands/list-agents.js";
import { registerStatusCommand } from "./src/commands/status.js";
import { registerRepairCommand } from "./src/commands/repair.js";
import { registerRebindThreadsCommand } from "./src/commands/rebind-threads.js";
import { registerRestartAgentCommand } from "./src/commands/restart-agent.js";
import { registerRemoveAgentCommand } from "./src/commands/remove-agent.js";
import { registerHelpCommand } from "./src/commands/help.js";
import { registerShowAgentCommand } from "./src/commands/show-agent.js";
import { registerUpgradeManifestsCommand } from "./src/commands/upgrade-manifests.js";
import { registerEmperorCli } from "./src/cli/register.js";
import { resolvePluginPaths } from "./src/state/paths.js";
import { emperorChannelPlugin } from "./src/channel/plugin.js";
import { createEmperorInboundService } from "./src/channel/inbound.js";

// Captured by setRuntime; available before any service.start() call.
let pluginRuntime: unknown = null;

export default defineChannelPluginEntry({
  id: "emperor-claw-os",
  name: "Emperor Claw OS",
  description: "Install, repair, and manage Emperor-connected OpenClaw agents and control-plane state.",
  plugin: emperorChannelPlugin,
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      apiUrl: { type: "string" },
      defaultOwnerName: { type: "string" },
      defaultOwnerTimezone: { type: "string" },
      manifestRoot: { type: "string" },
      stateRoot: { type: "string" }
    }
  },
  setRuntime(runtime) {
    pluginRuntime = runtime;
  },
  registerCliMetadata(api) {
    api.registerCli(({ program }) => {
      registerEmperorCli(api, program);
    }, {
      descriptors: [
        {
          name: "emperor",
          description: "Emperor Claw OS plugin commands",
          hasSubcommands: true
        }
      ]
    });
  },
  registerFull(api) {
    const paths = resolvePluginPaths(api);

    registerStatusCommand(api, paths);
    registerInstallCommand(api, paths);
    registerListAgentsCommand(api, paths);
    registerShowAgentCommand(api, paths);
    registerDoctorCommand(api, paths);
    registerUpgradeManifestsCommand(api, paths);
    registerRepairCommand(api, paths);
    registerRestartAgentCommand(api, paths);
    registerRemoveAgentCommand(api, paths);
    registerRebindThreadsCommand(api, paths);
    registerAddAgentCommand(api, paths);
    registerHelpCommand(api, paths);

    api.registerService(createEmperorInboundService(paths, () => pluginRuntime));
  }
});
