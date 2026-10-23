// Hermes profile config every Emperor agent runs with.
//
// Kept free of DB/Docker imports so it can be unit tested and shared. Two consumers apply the
// same list: the managed Docker entrypoint (passed as one env var, applied on every container
// start) and the remote installer (`GET /api/mcp/runtime/profile-defaults`). Re-applying is
// idempotent because each key is set, never appended.
//
// No `gateway.*` key belongs here: gateway topology (standalone, shared, managed) differs per
// deploy mode, so the entrypoint and the installer apply those keys themselves
// (docs/design/hermes-persistent-runtime.md sections 4.6, 7.3 and 7.4).

export const HERMES_CONFIG_DEFAULTS_ENV = "EMPEROR_CLAW_HERMES_CONFIG_DEFAULTS";

export const HERMES_PROFILE_CONFIG_DEFAULTS: ReadonlyArray<readonly [key: string, value: string]> = [
    // Without these, Hermes compacts only at ~50% of the model window and
    // agents were measured re-sending ~188k tokens per model call. The bridge
    // also compacts after the reply (60k), so this is the backstop.
    ["compression.threshold_tokens", "80000"],
    ["compression.proactive_prune_tokens", "48000"],
    // Off: Hermes checks idle compaction at the START of the next turn, so the
    // first message after a quiet spell waited for a full summary call (~80s
    // measured). Threshold compaction above still bounds the context.
    ["compression.idle_compact_after_seconds", "0"],
    // Sessions run with yolo, so approvals only matter as a backstop: an
    // unanswered prompt blocks the command after this many seconds instead of
    // Hermes' default 300 and the turn still completes.
    ["approvals.timeout", "60"],
    // Same backstop for clarify questions: Hermes' default (3600 s) would hold
    // a turn for an hour when nobody answers.
    ["agent.clarify_timeout", "60"],
    // On SIGTERM (restart, update, container stop) let running turns finish for
    // up to 30 s instead of interrupting them at once (Hermes' default is 0).
    // The gateway exits ~20 s after its drain (~50.5 s measured), inside the
    // 55 s supervisor and 70 s systemd stop budgets; 45 would get SIGKILLed
    // by the supervisor.
    ["agent.restart_drain_timeout", "30"],
    // Emperor names threads itself; Hermes' auxiliary title call is a paid
    // model request per session that nobody reads.
    ["auxiliary.title_generation.enabled", "false"],
    // Otherwise Emperor plugin tools hide behind tool_search/tool_describe/
    // tool_call, costing extra model round-trips per tool use. The ~40 Emperor
    // tool schemas are cheap once the provider's prompt cache holds them.
    ["tools.tool_search.enabled", "off"],
];

/**
 * Serialize the defaults as newline-separated `key=value` lines. Keys never
 * contain "=" or newlines, so the entrypoint can split each line on the first
 * "=" (`IFS== read -r key value`).
 */
export function hermesConfigDefaultsEnvValue(
    defaults: ReadonlyArray<readonly [string, string]> = HERMES_PROFILE_CONFIG_DEFAULTS,
): string {
    return defaults
        .map(([key, value]) => {
            if (!key || /[=\s]/.test(key) || /[\r\n]/.test(value)) {
                throw new Error(`Invalid Hermes config default: ${key}`);
            }
            return `${key}=${value}`;
        })
        .join("\n");
}
