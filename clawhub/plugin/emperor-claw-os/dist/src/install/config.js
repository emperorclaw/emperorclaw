import fs from "node:fs";
import path from "node:path";
export function resolveLocalConfigPath(paths) {
    return path.join(paths.emperorRoot, "plugin-config.json");
}
export function writeLocalConfig(paths, config) {
    const filePath = resolveLocalConfigPath(paths);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return filePath;
}
export function loadLocalConfig(paths) {
    try {
        return JSON.parse(fs.readFileSync(resolveLocalConfigPath(paths), "utf8"));
    }
    catch {
        return null;
    }
}
