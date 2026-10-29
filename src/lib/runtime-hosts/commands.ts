// What Emperor may ask a runtime host to do (0.21). Pure: no DB.
//
// Every command is on a fixed allowlist with validated arguments; the daemon
// validates again and runs argv lists only (never a shell). The database
// CHECK lists every command of the design so later releases need no schema
// change, but this release QUEUES only restart_agent and refresh_inventory:
// anything else is refused before it reaches the table. (`disconnect` stays
// out: revoking the host is the server-side way to cut it off, and
// `emperor-hermes host disconnect` the local one.)
//
// restart_agent carries no topology and no idle policy: the daemon's local
// record decides whether the profile is on a shared gateway, and a shared
// gateway restart always waits for idle unless the admin explicitly chose
// `force: true` (it restarts every agent on that gateway).

import { PROFILE_NAME_RE } from "./protocol";

export const ALL_HOST_COMMANDS = [
    "provision_agent", "update_runtime", "restart_agent", "remove_agent", "rotate_agent_token", "refresh_inventory", "disconnect",
] as const;
export type HostCommand = (typeof ALL_HOST_COMMANDS)[number];

/** The commands this release lets the server queue. */
export const ENABLED_HOST_COMMANDS: readonly HostCommand[] = ["restart_agent", "refresh_inventory"];

/** Seconds a job may run before it times out (the sweeper adds 60 s of grace). */
export const COMMAND_DEADLINE_SEC: Record<HostCommand, number> = {
    provision_agent: 1800,
    update_runtime: 1800,
    // Idle wait (240 s) + restart + gateway ready, with margin.
    restart_agent: 420,
    remove_agent: 300,
    rotate_agent_token: 300,
    refresh_inventory: 60,
    disconnect: 60,
};

export function isHostCommand(value: unknown): value is HostCommand {
    return typeof value === "string" && (ALL_HOST_COMMANDS as readonly string[]).includes(value);
}

export function isEnabledHostCommand(value: unknown): value is HostCommand {
    return isHostCommand(value) && ENABLED_HOST_COMMANDS.includes(value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEMVER_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const AGENT_TOKEN_RE = /^ec_[0-9a-f]{48}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Text safe to write into a .env value (the installer's safe_value). */
export function isSafeEnvValue(value: string): boolean {
    return !/["\\$`\n\r]/.test(value);
}

export type ValidatedArgs = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

function obj(input: unknown): Record<string, unknown> | null {
    return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
}

function onlyKeys(input: Record<string, unknown>, allowed: readonly string[]): string | null {
    const extra = Object.keys(input).filter((key) => !allowed.includes(key));
    return extra.length > 0 ? `unexpected argument(s): ${extra.join(", ")}` : null;
}

function profileOf(value: unknown): string | null {
    return typeof value === "string" && PROFILE_NAME_RE.test(value) ? value : null;
}

/**
 * Validate a command's arguments. Returns the normalized arguments (defaults
 * filled) or why they are refused. Tokens are NEVER accepted here except
 * where a command needs one (provision/rotate), and those are never stored
 * in args_json (see redactJobArgs).
 */
export function validateCommandArgs(command: HostCommand, input: unknown): ValidatedArgs {
    const args = obj(input ?? {});
    if (!args) return { ok: false, error: "args must be an object" };
    switch (command) {
        case "restart_agent": {
            const extra = onlyKeys(args, ["profile", "target", "force"]);
            if (extra) return { ok: false, error: extra };
            const profile = profileOf(args.profile);
            if (!profile) return { ok: false, error: "profile is not a valid profile name" };
            const target = args.target ?? "bridge";
            if (target !== "bridge" && target !== "gateway") return { ok: false, error: "target must be bridge or gateway" };
            if (args.force !== undefined && typeof args.force !== "boolean") return { ok: false, error: "force must be a boolean" };
            // force is only ever sent when the admin chose it; absent = the daemon's safe default.
            return { ok: true, args: { profile, target, ...(args.force === true ? { force: true } : {}) } };
        }
        case "refresh_inventory":
        case "disconnect": {
            const extra = onlyKeys(args, []);
            return extra ? { ok: false, error: extra } : { ok: true, args: {} };
        }
        case "provision_agent": {
            const extra = onlyKeys(args, ["profile", "agentId", "agentName", "apiToken", "gateway", "llmProvider", "model", "maxParallel", "skipBrowser"]);
            if (extra) return { ok: false, error: extra };
            const profile = profileOf(args.profile);
            if (!profile) return { ok: false, error: "profile is not a valid profile name" };
            if (typeof args.agentId !== "string" || !UUID_RE.test(args.agentId)) return { ok: false, error: "agentId must be a uuid" };
            if (typeof args.agentName !== "string" || !args.agentName.trim() || args.agentName.length > 80 || !isSafeEnvValue(args.agentName)) {
                return { ok: false, error: "agentName is not a safe name" };
            }
            if (typeof args.apiToken !== "string" || !AGENT_TOKEN_RE.test(args.apiToken)) return { ok: false, error: "apiToken has the wrong shape" };
            if (args.gateway !== "standalone" && args.gateway !== "shared") return { ok: false, error: "gateway must be standalone or shared" };
            if (typeof args.llmProvider !== "string" || !/^[a-z0-9_-]{1,40}$/.test(args.llmProvider)) return { ok: false, error: "llmProvider is not valid" };
            if (args.model !== undefined && (typeof args.model !== "string" || !MODEL_RE.test(args.model))) return { ok: false, error: "model is not valid" };
            const maxParallel = args.maxParallel ?? 1;
            if (typeof maxParallel !== "number" || !Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) return { ok: false, error: "maxParallel must be 1-8" };
            if (args.skipBrowser !== undefined && typeof args.skipBrowser !== "boolean") return { ok: false, error: "skipBrowser must be a boolean" };
            return { ok: true, args: { ...args, profile, maxParallel, skipBrowser: args.skipBrowser ?? false } };
        }
        case "update_runtime": {
            const extra = onlyKeys(args, ["version", "expectedSha256", "restartGateways"]);
            if (extra) return { ok: false, error: extra };
            if (typeof args.version !== "string" || !SEMVER_RE.test(args.version)) return { ok: false, error: "version must be x.y.z" };
            if (args.expectedSha256 !== undefined && (typeof args.expectedSha256 !== "string" || !SHA256_RE.test(args.expectedSha256))) {
                return { ok: false, error: "expectedSha256 must be a sha256 hex digest" };
            }
            if (args.restartGateways !== undefined && typeof args.restartGateways !== "boolean") return { ok: false, error: "restartGateways must be a boolean" };
            return { ok: true, args: { version: args.version, expectedSha256: args.expectedSha256 ?? null, restartGateways: args.restartGateways ?? false } };
        }
        case "remove_agent": {
            const extra = onlyKeys(args, ["profile", "agentId", "purge"]);
            if (extra) return { ok: false, error: extra };
            const profile = profileOf(args.profile);
            if (!profile) return { ok: false, error: "profile is not a valid profile name" };
            if (typeof args.agentId !== "string" || !UUID_RE.test(args.agentId)) return { ok: false, error: "agentId must be a uuid" };
            if (args.purge !== undefined && typeof args.purge !== "boolean") return { ok: false, error: "purge must be a boolean" };
            return { ok: true, args: { profile, agentId: args.agentId, purge: args.purge ?? false } };
        }
        case "rotate_agent_token": {
            const extra = onlyKeys(args, ["profile", "agentId", "apiToken"]);
            if (extra) return { ok: false, error: extra };
            const profile = profileOf(args.profile);
            if (!profile) return { ok: false, error: "profile is not a valid profile name" };
            if (typeof args.agentId !== "string" || !UUID_RE.test(args.agentId)) return { ok: false, error: "agentId must be a uuid" };
            if (typeof args.apiToken !== "string" || !AGENT_TOKEN_RE.test(args.apiToken)) return { ok: false, error: "apiToken has the wrong shape" };
            return { ok: true, args: { profile, agentId: args.agentId, apiToken: args.apiToken } };
        }
    }
}

/** Arguments as stored in runtime_host_jobs.args_json: never a token. */
export function redactJobArgs(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
        if (/token|secret|key|password/i.test(key)) continue;
        out[key] = value;
    }
    return out;
}

export type QueueDecision =
    | { ok: true; command: HostCommand; args: Record<string, unknown>; deadlineSec: number }
    | { ok: false; status: number; error: string };

/** Whether this server may queue the command, with its validated arguments. */
export function planHostCommand(command: unknown, args: unknown): QueueDecision {
    if (!isHostCommand(command)) return { ok: false, status: 400, error: "Unknown command" };
    if (!isEnabledHostCommand(command)) return { ok: false, status: 400, error: `${command} is not available in this release` };
    const validated = validateCommandArgs(command, args);
    if (!validated.ok) return { ok: false, status: 400, error: validated.error };
    return { ok: true, command, args: validated.args, deadlineSec: COMMAND_DEADLINE_SEC[command] };
}
