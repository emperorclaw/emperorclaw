import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type EmperorPluginPaths = {
  pluginRoot: string;
  emperorRoot: string;
  manifestRoot: string;
  stateRoot: string;
  threadOwnerPath: string;
};

export function resolvePluginPaths(api: any): EmperorPluginPaths {
  const cfg = (api.pluginConfig || {}) as Record<string, string | undefined>;
  const emperorRoot = path.join(os.homedir(), ".openclaw", "emperor");
  const manifestRoot = cfg.manifestRoot || path.join(emperorRoot, "agents");
  const stateRoot = cfg.stateRoot || path.join(emperorRoot, "state");
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const pluginRoot = path.basename(moduleRoot) === "dist" ? path.dirname(moduleRoot) : moduleRoot;
  return {
    pluginRoot,
    emperorRoot,
    manifestRoot,
    stateRoot,
    threadOwnerPath: path.join(stateRoot, "thread-owners.json")
  };
}

export function ensurePluginLayout(paths: EmperorPluginPaths): void {
  fs.mkdirSync(paths.manifestRoot, { recursive: true });
  fs.mkdirSync(paths.stateRoot, { recursive: true });
  if (!fs.existsSync(paths.threadOwnerPath)) {
    fs.writeFileSync(paths.threadOwnerPath, "{}\n", "utf8");
  }
}
