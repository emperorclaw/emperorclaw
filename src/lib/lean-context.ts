/**
 * Assembles the lean per-session context a bridge gets: the kernel, the
 * knowledge index, the always-block, and the roster, plus a content hash so a
 * bridge can skip re-sending unchanged context (ETag).
 */
import { createHash } from "node:crypto";
import { loadAgentScopeContext } from "@/lib/agent-scope";
import { listAgentsForCompany } from "@/lib/agents-crud";
import { BRIDGE_KERNEL } from "@/lib/emperor-manual";
import { normalizeMention } from "@/lib/message-routing";
import { buildKnowledgeIndex } from "@/lib/resources";

export const LEAN_CONTEXT_VERSION = 1;
export const ROSTER_MAX_AGENTS = 50;
export const ROSTER_ROLE_MAX_CHARS = 60;

export type RosterEntry = {
  id: string;
  name: string;
  alias: string;
  role: string;
  line: string;
};

/** Split a name into ordered alias candidates: first token, hyphenated, full. */
function aliasCandidates(name: string): string[] {
  const cleaned = name.replace(/\([^)]*\)/g, "").split(/\s+[-—|]\s+/)[0].trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const raw = [parts[0], parts.join("-"), cleaned].filter((value): value is string => Boolean(value));
  const stripped = raw.map((value) => value.replace(/^@+/, "").trim()).filter(Boolean);
  return stripped.length ? stripped : ["agent"];
}

/**
 * A distinct @alias for one agent: its first name when free, else its
 * hyphenated/full name, else a numbered suffix. Normalization matches the
 * mention router so a displayed alias always resolves.
 */
function pickAlias(name: string, used: Set<string>, ordinal: number): string {
  for (const candidate of aliasCandidates(name)) {
    const key = normalizeMention(candidate);
    if (key && !used.has(key)) {
      used.add(key);
      return candidate;
    }
  }
  let fallback = `${aliasCandidates(name)[0]}-${ordinal + 1}`;
  while (used.has(normalizeMention(fallback))) fallback = `${fallback}x`;
  used.add(normalizeMention(fallback));
  return fallback;
}

/** `@alias — role` one line per agent, role trimmed to 60 chars. */
export async function buildAgentRoster(companyId: string, agentIdFilter: ReadonlySet<string> | null = null): Promise<{ text: string; entries: RosterEntry[] }> {
  const agents = await listAgentsForCompany({ companyId, limit: ROSTER_MAX_AGENTS, agentIdFilter });
  const used = new Set<string>();
  const entries: RosterEntry[] = agents.map((agent, index) => {
    const name = agent.name || "unknown";
    const alias = pickAlias(name, used, index);
    const role = (agent.role || "").trim().slice(0, ROSTER_ROLE_MAX_CHARS);
    return { id: agent.id, name, alias, role, line: role ? `@${alias} \u2014 ${role}` : `@${alias}` };
  });
  const text = entries.length
    ? entries.map((entry) => entry.line).join("\n")
    : "Roster: no agents.";
  return { text, entries };
}

export type LeanContext = {
  version: number;
  kernel: string;
  knowledgeIndex: string;
  alwaysBlock: string;
  roster: string;
  alwaysOverBudget: boolean;
  alwaysUsedChars: number;
  hash: string;
};

/** The full lean payload plus a stable hash for ETag / change detection. */
export async function buildLeanContext(input: {
  companyId: string;
  agentId?: string | null;
}): Promise<LeanContext> {
  const [roster, knowledge] = await Promise.all([
    // The prompt roster lists only the agents this agent may work with.
    loadAgentScopeContext(input.companyId, input.agentId ?? null).then((scope) => buildAgentRoster(input.companyId, scope.allowedAgentIds)),
    buildKnowledgeIndex({ companyId: input.companyId, agentId: input.agentId ?? null }),
  ]);

  const payload = {
    version: LEAN_CONTEXT_VERSION,
    kernel: BRIDGE_KERNEL,
    knowledgeIndex: knowledge.knowledgeIndex,
    alwaysBlock: knowledge.alwaysBlock,
    roster: roster.text,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");

  return {
    ...payload,
    alwaysOverBudget: knowledge.alwaysOverBudget,
    alwaysUsedChars: knowledge.alwaysUsedChars,
    hash,
  };
}
