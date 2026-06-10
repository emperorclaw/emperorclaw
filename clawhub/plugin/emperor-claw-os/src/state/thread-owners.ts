import fs from "node:fs";
import type { EmperorPluginPaths } from "./paths.js";

export type ThreadOwnerMap = Record<string, string>;

export function loadThreadOwners(paths: EmperorPluginPaths): ThreadOwnerMap {
  try {
    return JSON.parse(fs.readFileSync(paths.threadOwnerPath, "utf8"));
  } catch {
    return {};
  }
}

export function saveThreadOwners(paths: EmperorPluginPaths, owners: ThreadOwnerMap): void {
  fs.writeFileSync(paths.threadOwnerPath, `${JSON.stringify(owners, null, 2)}\n`, "utf8");
}

export function setThreadOwner(paths: EmperorPluginPaths, threadId: string, agentId: string): void {
  const owners = loadThreadOwners(paths);
  owners[threadId] = agentId;
  saveThreadOwners(paths, owners);
}

export function clearThreadOwner(paths: EmperorPluginPaths, threadId: string): void {
  const owners = loadThreadOwners(paths);
  delete owners[threadId];
  saveThreadOwners(paths, owners);
}
