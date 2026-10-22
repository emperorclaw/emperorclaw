// Hermes profile config every Emperor-provisioned agent starts with.
//
// Kept free of DB/Docker imports so it can be unit tested and shared. The
// provisioner passes these to the runtime container as one env var; the
// container entrypoint applies each pair with `hermes -p <profile> config set
// <key> <value>` on every start. `config set` overwrites, so re-applying on a
// recreate (image update, key rotation, crash repair) is idempotent.

export const HERMES_CONFIG_DEFAULTS_ENV = "EMPEROR_CLAW_HERMES_CONFIG_DEFAULTS";

export const HERMES_PROFILE_CONFIG_DEFAULTS: ReadonlyArray<readonly [key: string, value: string]> = [
    // Without these, Hermes compacts only at ~50% of the model window and
    // agents were measured re-sending ~188k tokens per model call.
    ["compression.threshold_tokens", "80000"],
    ["compression.proactive_prune_tokens", "48000"],
    // Off: Hermes checks idle compaction at the START of the next turn, so the
    // first message after a quiet spell waited for a full summary call (~80s
    // measured). Threshold compaction above still bounds the context.
    ["compression.idle_compact_after_seconds", "0"],
    // The bridge runs `hermes chat -q`. Its default single-query approval mode
    // (`deny`) silently blocks shell heredocs and similar commands.
    ["approvals.single_query_mode", "approve"],
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
