// Who an MCP write is recorded as. Pure (no database): the REST gate
// (lib/action-policy-server.ts, run by verifyMcpToken for every agent REST
// call), the MCP server (lib/mcp-server/index.ts) and the view service
// (lib/views.ts) all decide with it, so no write path invents its own rule.
//
// Token kinds (company_tokens):
// - bound to an agent (agent_id set): a runtime token; every call acts as
//   that agent;
// - company-wide (agent_id NULL), minted by a person in Settings → Access
//   tokens or an agent's Connect tab (created_by_user_id = that person), by
//   OAuth (the person who approved it) or, for older installs, with no person
//   recorded. The row does not say whether a person or an agent fleet holds
//   it, so the CHANNEL decides:
//   - the agent REST API (/api/mcp/**) is what runtimes call (bridges, the
//     Hermes plugin, agent scripts): a write there acts for an agent and must
//     name it (`agentId`). Naming none is refused (400), never recorded as
//     "system" — an anonymous write has no maintainer and nobody to answer for it;
//   - the MCP server (/mcp) is a person's connection (Claude Code, Codex,
//     claude.ai): a write naming no agent is recorded as the person who
//     minted the token. A token with no person recorded is refused.

/** The 400 a company-wide token gets for a REST write that names no agent. */
export const AGENT_ID_REQUIRED_ERROR = "agentId required: a company-wide token must say which agent is acting (?agentId=<id>)";
/** The same, for routes that read the acting agent from the JSON body. */
export const AGENT_ID_REQUIRED_BODY_ERROR = "agentId required: a company-wide token must say which agent is acting (\"agentId\" in the request body)";
/** An MCP server connection whose token names no agent and records no person. */
export const NO_PERSON_ON_TOKEN_ERROR = "This connection acts as no agent and its token records no person, so Emperor cannot say who made this change. Create a new access token in Settings → Access tokens (it is recorded as yours), or use an agent's own token.";

export type McpWriteChannel = "rest" | "mcp_server";

export type McpWriter =
    | { kind: "agent"; agentId: string }
    /** An agent is named but not resolved yet: the route resolves it (and answers 404 for an unknown one). */
    | { kind: "named_agent" }
    | { kind: "person"; userId: string }
    | { kind: "refused"; status: 400; error: string };

/**
 * Decide who a write acts as.
 * - `boundAgentId`: the token's agent (agent-bound tokens).
 * - `namedAgent`: whether the request names an agent (a company-wide token's
 *   ?agentId= or body agentId); its resolution is the route's job (unknown
 *   names still answer 404 there).
 * - `actingAgentId`: the resolved acting agent, when known.
 * - `tokenCreatorUserId`: company_tokens.created_by_user_id.
 * - `agentIn`: where a REST route reads the agent (for the error text).
 */
export function decideMcpWriter(input: {
    channel: McpWriteChannel;
    boundAgentId?: string | null;
    namedAgent?: boolean;
    actingAgentId?: string | null;
    tokenCreatorUserId?: string | null;
    agentIn?: "query" | "body";
}): McpWriter {
    const agentId = input.boundAgentId || input.actingAgentId || null;
    if (agentId) return { kind: "agent", agentId };
    if (input.channel === "rest") {
        if (input.namedAgent) return { kind: "named_agent" };
        return { kind: "refused", status: 400, error: input.agentIn === "body" ? AGENT_ID_REQUIRED_BODY_ERROR : AGENT_ID_REQUIRED_ERROR };
    }
    if (input.tokenCreatorUserId) return { kind: "person", userId: input.tokenCreatorUserId };
    return { kind: "refused", status: 400, error: NO_PERSON_ON_TOKEN_ERROR };
}

/**
 * The person an MCP server connection acts as when it names no agent: the
 * token's creator, for a company-wide token; null for an agent-bound token or
 * a token with no person recorded.
 */
export function mcpServerOperatorUserId(token: { agentId?: string | null; createdByUserId?: string | null }): string | null {
    if (token.agentId) return null;
    return token.createdByUserId ?? null;
}
