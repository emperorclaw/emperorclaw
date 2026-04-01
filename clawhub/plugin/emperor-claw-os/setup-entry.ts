import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "emperor-claw-os",
  name: "Emperor Claw OS",
  description: "Setup entry for Emperor Claw OS plugin.",
  configSchema: { type: "object", additionalProperties: true },
  register(api) {
    api.logger.info("Emperor Claw OS setup entry loaded", { mode: api.registrationMode });
  }
});
