/**
 * The outcome of an agent's last managed-runtime setup, kept on
 * agents.metadata_json.runtimeSetup (written by recordRuntimeSetup in
 * hermes-provisioning.ts). Pure and client-safe: the Agents page reads it to
 * say "setup failed" with the reason and a retry, instead of "starting up"
 * for an agent whose container never started.
 */
export type RuntimeSetupRecord = { status: "started" | "failed"; message: string; at: string };

export function runtimeSetupOf(metadata: unknown): RuntimeSetupRecord | null {
    const value = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).runtimeSetup : null;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if ((record.status !== "started" && record.status !== "failed") || typeof record.message !== "string" || typeof record.at !== "string") return null;
    return { status: record.status, message: record.message, at: record.at };
}
