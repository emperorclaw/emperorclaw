export const BRIDGE_CONTRACT_VERSION = "2026-04-01";

export const REQUIRED_BRIDGE_CAPABILITIES = [
  "thread-send",
  "thread-receive-websocket",
  "thread-receive-sync-fallback",
  "direct-thread-binding",
  "agent-targeting",
  "agent-mention-delegation",
  "heartbeat-lease-renewal",
  "task-claim-result-truth",
  "local-brain-handoff",
  "state-journal-dedupe"
] as const;

export type EmperorBridgeCapability = typeof REQUIRED_BRIDGE_CAPABILITIES[number];

export type EmperorBridgeContract = {
  version: string;
  capabilities: EmperorBridgeCapability[];
  messageTransport: {
    realtime: "websocket";
    fallback: "sync";
  };
  taskTruth: "claim-note-checkpoint-result";
};

export type EmperorThreadPolicy = {
  direct: "bound";
  team: "mention-required";
  delegation: "explicit-mention";
};

export const DEFAULT_THREAD_POLICY: EmperorThreadPolicy = {
  direct: "bound",
  team: "mention-required",
  delegation: "explicit-mention"
};

export function createDefaultBridgeContract(): EmperorBridgeContract {
  return {
    version: BRIDGE_CONTRACT_VERSION,
    capabilities: [...REQUIRED_BRIDGE_CAPABILITIES],
    messageTransport: {
      realtime: "websocket",
      fallback: "sync"
    },
    taskTruth: "claim-note-checkpoint-result"
  };
}

export function getMissingBridgeCapabilities(contract?: Partial<EmperorBridgeContract> | null): string[] {
  const actual = new Set(Array.isArray(contract?.capabilities) ? contract!.capabilities : []);
  return REQUIRED_BRIDGE_CAPABILITIES.filter((capability) => !actual.has(capability));
}

export function hasRequiredThreadPolicy(policy?: Partial<EmperorThreadPolicy> | null): boolean {
  return policy?.direct === DEFAULT_THREAD_POLICY.direct
    && policy?.team === DEFAULT_THREAD_POLICY.team
    && policy?.delegation === DEFAULT_THREAD_POLICY.delegation;
}
