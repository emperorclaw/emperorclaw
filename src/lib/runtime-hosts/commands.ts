// What Emperor may ask a runtime host to do (0.21+). Pure: no DB.
//
// Every command is on a fixed allowlist with validated arguments; the daemon
// validates again and runs argv lists only (never a shell). The database
// CHECK lists every command of the design so later releases need no schema
// change, but this release QUEUES only restart_agent, refresh_inventory,
// provision_agent and remove_agent: anything else is refused before it
// reaches the table. (`disconnect` stays out: revoking the host is the
// server-side way to cut it off, and `emperor-hermes host disconnect` the
// local one.)
//
// A host runs only the commands its daemon advertised in hello (0.22+); a
// 0.21 daemon advertises nothing and runs restart_agent + refresh_inventory.
//
// restart_agent carries no topology and no idle policy: the daemon's local
// record decides whether the profile is on a shared gateway, and a shared
// gateway restart always waits for idle unless the admin explicitly chose
// `force: true` (it restarts every agent on that gateway).
//
// provision_agent carries no token when it is queued: the agent's token is
// minted when the job is sent (store.claimNextJob) and travels only in that
// command frame. The daemon takes the Emperor URL from its own hostd.env and
// the model provider's API key from a file on the host: neither comes from here.

import { PROFILE_NAME_RE } from "./protocol";

export const ALL_HOST_COMMANDS = [
    "provision_agent", "update_runtime", "restart_agent", "remove_agent", "rotate_agent_token", "refresh_inventory", "disconnect",
] as const;
export type HostCommand = (typeof ALL_HOST_COMMANDS)[number];

/** The commands this release lets the server queue. */
export const ENABLED_HOST_COMMANDS: readonly HostCommand[] = ["restart_agent", "refresh_inventory", "provision_agent", "remove_agent"];

/** What a daemon that lists no commands in hello (0.21) runs. */
export const LEGACY_HOST_COMMANDS: readonly HostCommand[] = ["restart_agent", "refresh_inventory"];

/** The commands a host runs, from what its daemon advertised in hello (nothing = a 0.21 daemon). */
export function hostCommandsFrom(advertised: unknown): HostCommand[] {
    if (!Array.isArray(advertised)) return [...LEGACY_HOST_COMMANDS];
    return ALL_HOST_COMMANDS.filter((c) => advertised.includes(c));
}

export function hostSupports(hostCommands: readonly string[], command: HostCommand): boolean {
    return hostCommands.includes(command);
}

/** LLM providers a host can set a new agent up with (the daemon maps each to its Hermes provider and key name). */
export const HOST_LLM_PROVIDERS = ["openrouter", "deepseek", "openai", "anthropic", "google", "grok"] as const;
export type HostLlmProvider = (typeof HOST_LLM_PROVIDERS)[number];

export function isHostLlmProvider(value: unknown): value is HostLlmProvider {
    return typeof value === "string" && (HOST_LLM_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The model a new hosted agent gets when the admin leaves it empty: the
 * defaults the managed Docker runtime uses (integrations/hermes/entrypoint.sh),
 * OpenRouter's being free.
 */
export const DEFAULT_HOST_MODEL: Record<HostLlmProvider, string> = {
    openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free",
    deepseek: "deepseek-chat",
    openai: "gpt-4o-mini",
    anthropic: "claude-3-5-haiku-latest",
    google: "gemini-1.5-flash",
    grok: "grok-2-latest",
};

/**
 * Free memory (MiB) a new agent needs on its host: a standalone gateway
 * (~300) + bridge (~45) as in the installer's plan, plus headroom; on a
 * shared gateway only its share.
 */
export const PROVISION_MEMORY_MIB = { standalone: 512, shared: 160 } as const;

/** Hermes profile ids (hermes_constants.PROFILE_ID_RE, v0.22.4): lowercase, digits, `_` and `-`. */
export const HERMES_PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Names Hermes refuses for a profile, or that shadow a hermes subcommand. */
export const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set([
    "hermes", "default", "test", "tmp", "root", "sudo",
    "chat", "model", "gateway", "setup", "whatsapp", "login", "logout", "status", "cron", "doctor", "dump", "config",
    "pairing", "skills", "tools", "mcp", "connectors", "sessions", "insights", "version", "update", "uninstall", "profile",
    "plugins", "honcho", "acp",
]);

/**
 * A Hermes profile name for a new agent on a host: a lowercase slug of its
 * name, never reserved, unique among `taken` (the host's profiles and those
 * already promised to other agents): "Growth Hacker" -> growth-hacker, then
 * growth-hacker-2, ...
 */
export function profileSlugForAgent(agentName: string, taken: Iterable<string>): string {
    const used = new Set([...taken].map((t) => t.toLowerCase()));
    let base = agentName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
    if (!base) base = "agent";
    if (RESERVED_PROFILE_NAMES.has(base)) base = `${base}-agent`;
    let candidate = base;
    for (let n = 2; used.has(candidate) || RESERVED_PROFILE_NAMES.has(candidate); n++) candidate = `${base}-${n}`;
    return candidate;
}

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
/** A model id: never starting with "-" (it is a positional value of `hermes config set`). */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const AGENT_TOKEN_RE = /^ec_[0-9a-f]{48}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function isValidHostModel(value: unknown): value is string {
    return typeof value === "string" && MODEL_RE.test(value);
}

/**
 * Text safe to write into a .env value (the installer's safe_value): no quote, backslash, $ or
 * backtick, and nothing that ends a line for Python's str.splitlines() (every control character,
 * NEL, LS, PS), so a value can never become a second line in the profile .env.
 */
export function isSafeEnvValue(value: string): boolean {
    return !/["\\$`]/.test(value) && !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(value);
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
 * where a command needs one (rotate), and those are never stored in args_json
 * (see redactJobArgs). provision_agent is validated twice: when it is queued
 * (`stage: "queue"`: no token, it does not exist yet) and when it is sent
 * (`stage: "dispatch"`: the freshly minted token is required).
 */
export function validateCommandArgs(command: HostCommand, input: unknown, opts: { stage?: "queue" | "dispatch" } = {}): ValidatedArgs {
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
            const profile = typeof args.profile === "string" && HERMES_PROFILE_ID_RE.test(args.profile) && !RESERVED_PROFILE_NAMES.has(args.profile)
                ? args.profile : null;
            if (!profile) return { ok: false, error: "profile is not a profile name Hermes accepts" };
            if (typeof args.agentId !== "string" || !UUID_RE.test(args.agentId)) return { ok: false, error: "agentId must be a uuid" };
            if (typeof args.agentName !== "string" || !args.agentName.trim() || args.agentName !== args.agentName.trim()
                || args.agentName.length > 80 || !isSafeEnvValue(args.agentName)) {
                return { ok: false, error: "agentName is not a safe name" };
            }
            const stage = opts.stage ?? "dispatch";
            if (stage === "queue" && args.apiToken !== undefined) return { ok: false, error: "apiToken is minted when the job is sent, never queued" };
            if (stage === "dispatch" && (typeof args.apiToken !== "string" || !AGENT_TOKEN_RE.test(args.apiToken))) {
                return { ok: false, error: "apiToken has the wrong shape" };
            }
            if (args.gateway !== "standalone" && args.gateway !== "shared") return { ok: false, error: "gateway must be standalone or shared" };
            if (!isHostLlmProvider(args.llmProvider)) return { ok: false, error: "llmProvider is not one a host supports" };
            if (args.model !== undefined && !isValidHostModel(args.model)) return { ok: false, error: "model is not valid" };
            if (args.maxParallel !== undefined && (typeof args.maxParallel !== "number" || !Number.isInteger(args.maxParallel) || args.maxParallel < 1 || args.maxParallel > 8)) {
                return { ok: false, error: "maxParallel must be 1-8" };
            }
            if (args.skipBrowser !== undefined && typeof args.skipBrowser !== "boolean") return { ok: false, error: "skipBrowser must be a boolean" };
            const out: Record<string, unknown> = {
                profile, agentId: args.agentId.toLowerCase(), agentName: args.agentName, gateway: args.gateway, llmProvider: args.llmProvider,
                skipBrowser: args.skipBrowser ?? false,
            };
            if (args.model !== undefined) out.model = args.model;
            if (args.maxParallel !== undefined) out.maxParallel = args.maxParallel;
            if (stage === "dispatch") out.apiToken = args.apiToken;
            return { ok: true, args: out };
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
            return { ok: true, args: { profile, agentId: args.agentId.toLowerCase(), purge: args.purge ?? false } };
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

/**
 * Whether this server may queue the command, with its validated arguments.
 * With `hostCommands` (what the host's daemon runs), a command it does not
 * know is refused with 409 and the UI asks to update the host.
 */
export function planHostCommand(command: unknown, args: unknown, opts: { hostCommands?: readonly string[] } = {}): QueueDecision {
    if (!isHostCommand(command)) return { ok: false, status: 400, error: "Unknown command" };
    if (!isEnabledHostCommand(command)) return { ok: false, status: 400, error: `${command} is not available in this release` };
    const validated = validateCommandArgs(command, args, { stage: "queue" });
    if (!validated.ok) return { ok: false, status: 400, error: validated.error };
    if (opts.hostCommands && !hostSupports(opts.hostCommands, command)) {
        return { ok: false, status: 409, error: "Update this host to use this (its host daemon is older than 0.22)" };
    }
    return { ok: true, command, args: validated.args, deadlineSec: COMMAND_DEADLINE_SEC[command] };
}
