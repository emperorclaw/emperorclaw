declare module "openclaw/plugin-sdk/core" {
  export type OpenClawConfig = any;

  export function defineChannelPluginEntry(definition: any): any;
  export function defineSetupPluginEntry(plugin: any): any;
  export function createChannelPluginBase(options: any): any;
  export function createChatChannelPlugin(options: any): any;
}
