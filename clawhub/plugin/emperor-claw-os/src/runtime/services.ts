import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
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

/**
 * Parse the .env file written by writeEnvFile (values are JSON-serialized strings).
 * Returns a flat Record<string, string> suitable for merging into process.env.
 */
function parseEnvFile(envFile: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(envFile)) return result;
  const lines = fs.readFileSync(envFile, "utf8").split("\n");
  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") {
        result[key] = parsed;
      }
    } catch {
      result[key] = raw.replace(/^"(.*)"$/, "$1");
    }
  }
  return result;
}

/**
 * Launch the bridge as a detached Node.js child process.
 * On both Windows and Linux this spawns node directly — no shell, no PowerShell,
 * no ExecutionPolicy bypass, no hidden window tricks.
 * Output is appended to bridge-fallback.log in the companion dir.
 */
export async function startFallbackBridge(companionDir: string): Promise<string> {
  const logPath = path.join(companionDir, "bridge-fallback.log");
  const envFile = path.join(companionDir, ".env");
  const bridgePath = path.join(companionDir, "runtime", "bridge.js");
  const configPath = path.join(companionDir, "bridge.config.json");

  const fileEnv = parseEnvFile(envFile);
  const nodeBin: string = fileEnv["EMPEROR_CLAW_NODE_BIN"] || process.execPath;

  const childEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
    ),
    ...fileEnv,
    EMPEROR_CLAW_CONFIG_PATH: configPath,
    EMPEROR_CLAW_RECONNECT_BASE_MS: fileEnv["EMPEROR_CLAW_RECONNECT_BASE_MS"] || "2000",
    EMPEROR_CLAW_RECONNECT_MAX_MS: fileEnv["EMPEROR_CLAW_RECONNECT_MAX_MS"] || "60000",
  };

  const logFd = fs.openSync(logPath, "a");
  const child = spawn(nodeBin, [bridgePath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: childEnv,
    windowsHide: true,
  });
  child.unref();

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
