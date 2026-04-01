import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type EmperorPluginPaths = {
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
  return {
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
