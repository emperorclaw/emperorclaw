import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
export function resolvePluginPaths(api) {
    const cfg = (api.pluginConfig || {});
    const emperorRoot = path.join(os.homedir(), ".openclaw", "emperor");
    const manifestRoot = cfg.manifestRoot || path.join(emperorRoot, "agents");
    const stateRoot = cfg.stateRoot || path.join(emperorRoot, "state");
    const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    return {
        pluginRoot,
        emperorRoot,
        manifestRoot,
        stateRoot,
        threadOwnerPath: path.join(stateRoot, "thread-owners.json")
    };
}
export function ensurePluginLayout(paths) {
    fs.mkdirSync(paths.manifestRoot, { recursive: true });
    fs.mkdirSync(paths.stateRoot, { recursive: true });
    if (!fs.existsSync(paths.threadOwnerPath)) {
        fs.writeFileSync(paths.threadOwnerPath, "{}\n", "utf8");
    }
}
