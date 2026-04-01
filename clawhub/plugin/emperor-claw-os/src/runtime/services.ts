import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function reloadAndRestartService(serviceName: string): Promise<{ mode: "systemd" | "fallback"; detail: string }> {
  try {
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    await execFileAsync("systemctl", ["--user", "enable", `${serviceName}.service`]);
    await execFileAsync("systemctl", ["--user", "restart", `${serviceName}.service`]);
    return { mode: "systemd", detail: `${serviceName}.service restarted via systemd --user` };
  } catch {
    return { mode: "fallback", detail: `${serviceName}.service could not be restarted via systemd --user` };
  }
}

export async function startFallbackBridge(companionDir: string): Promise<string> {
  const launcher = path.join(companionDir, "run-bridge.sh");
  const logPath = path.join(companionDir, "bridge-fallback.log");
  await execFileAsync("bash", ["-lc", `nohup ${JSON.stringify(launcher)} >> ${JSON.stringify(logPath)} 2>&1 &`]);
  return logPath;
}

export async function serviceIsActive(serviceName: string): Promise<boolean> {
  try {
    await execFileAsync("systemctl", ["--user", "is-active", serviceName]);
    return true;
  } catch {
    return false;
  }
}

export function fallbackLogExists(companionDir: string): boolean {
  return fs.existsSync(path.join(companionDir, "bridge-fallback.log"));
}
