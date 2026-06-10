import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { EmperorPluginPaths } from "../state/paths.js";

export type EmperorLocalConfig = {
  apiUrl: string;
  defaultOwnerName: string;
  defaultOwnerTimezone: string;
  installedAt: string;
};

export function resolveLocalConfigPath(paths: EmperorPluginPaths): string {
  return path.join(paths.emperorRoot, "plugin-config.json");
}

export function writeLocalConfig(paths: EmperorPluginPaths, config: EmperorLocalConfig): string {
  const filePath = resolveLocalConfigPath(paths);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

export function loadLocalConfig(paths: EmperorPluginPaths): EmperorLocalConfig | null {
  try {
    return JSON.parse(fs.readFileSync(resolveLocalConfigPath(paths), "utf8"));
  } catch {
    return null;
  }
}
