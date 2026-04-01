export const EMPEROR_CHANNEL_OWNS = [
  "session-grammar",
  "outbound-thread-send",
  "direct-thread-binding",
  "target-agent-routing",
  "agent-mention-delegation",
  "threading-policy",
  "local-brain-handoff"
] as const;

export const EMPEROR_CONTROL_PLUGIN_OWNS = [
  "install-doctor-repair-remove",
  "runtime-register",
  "session-heartbeat-lifecycle",
  "task-claim-result-note-checkpoint",
  "memory-resources-artifacts",
  "manifest-upgrades",
  "state-journal"
] as const;

export const LEGACY_BRIDGE_COMPATIBILITY_ONLY = [
  "websocket-sync-fallback-transport",
  "old-install-wrapper"
] as const;

