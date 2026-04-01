export type EmperorBrainInvocation = {
  sessionId: string;
  runId: string;
  sessionFile: string;
  workspaceDir: string;
  prompt: string;
  timeoutMs: number;
};

export type EmperorBrainResult = {
  sessionId?: string | null;
  text?: string | null;
  raw?: unknown;
};

type EmbeddedRuntimeAgent = {
  ensureAgentWorkspace?: (cfg: unknown) => Promise<unknown>;
  runEmbeddedPiAgent: (input: EmperorBrainInvocation) => Promise<Record<string, unknown>>;
};

export async function runBrainViaRuntimeAgent(input: {
  runtimeAgent: EmbeddedRuntimeAgent;
  cfg: unknown;
  invocation: EmperorBrainInvocation;
}): Promise<EmperorBrainResult> {
  if (input.runtimeAgent.ensureAgentWorkspace) {
    await input.runtimeAgent.ensureAgentWorkspace(input.cfg);
  }

  const raw = await input.runtimeAgent.runEmbeddedPiAgent(input.invocation);
  const text = extractBrainText(raw);

  return {
    raw,
    text,
    sessionId: readSessionId(raw)
  };
}

export function extractBrainText(raw: unknown): string | null {
  const value = raw as Record<string, any> | null;
  const payloads = Array.isArray(value?.payloads) ? value.payloads : Array.isArray(value?.result?.payloads) ? value?.result?.payloads : [];
  const payloadTexts = payloads
    .map((item) => (item && typeof item.text === "string" ? item.text.trim() : ""))
    .filter(Boolean);

  if (payloadTexts.length > 0) {
    return payloadTexts.join("\n\n");
  }

  const candidates = [
    value?.reply,
    value?.text,
    value?.message,
    value?.result?.reply,
    value?.result?.text,
    value?.result?.message
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

export function readSessionId(raw: unknown): string | null {
  const value = raw as Record<string, any> | null;
  const candidates = [
    value?.sessionId,
    value?.session_id,
    value?.session?.id,
    value?.meta?.agentMeta?.sessionId,
    value?.result?.sessionId,
    value?.result?.session_id,
    value?.result?.session?.id,
    value?.result?.meta?.agentMeta?.sessionId
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return null;
}
