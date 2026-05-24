import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
function psQuote(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}
export async function reloadAndRestartService(serviceName) {
    try {
        await execFileAsync("systemctl", ["--user", "daemon-reload"]);
        await execFileAsync("systemctl", ["--user", "enable", `${serviceName}.service`]);
        await execFileAsync("systemctl", ["--user", "restart", `${serviceName}.service`]);
        return { mode: "systemd", detail: `${serviceName}.service restarted via systemd --user` };
    }
    catch {
        return { mode: "fallback", detail: `${serviceName}.service could not be restarted via systemd --user` };
    }
}
export async function startFallbackBridge(companionDir) {
    const logPath = path.join(companionDir, "bridge-fallback.log");
    if (process.platform === "win32") {
        const launcher = path.join(companionDir, "run-bridge.ps1");
        const childCommand = `& { & ${psQuote(launcher)} *>> ${psQuote(logPath)} }`;
        await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            `Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command',${psQuote(childCommand)}) -WindowStyle Hidden`
        ], {
            windowsHide: true
        });
        return logPath;
    }
    const logFd = fs.openSync(logPath, "a");
    const launcher = path.join(companionDir, "run-bridge.sh");
    const child = spawn(launcher, [], {
        detached: true,
        stdio: ["ignore", logFd, logFd]
    });
    child.unref();
    return logPath;
}
export async function serviceIsActive(serviceName) {
    try {
        await execFileAsync("systemctl", ["--user", "is-active", serviceName]);
        return true;
    }
    catch {
        return false;
    }
}
export function fallbackLogExists(companionDir) {
    return fs.existsSync(path.join(companionDir, "bridge-fallback.log"));
}
