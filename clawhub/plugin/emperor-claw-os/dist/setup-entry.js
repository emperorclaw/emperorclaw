import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { emperorChannelPlugin } from "./src/channel/plugin.js";
export default defineSetupPluginEntry(emperorChannelPlugin);
