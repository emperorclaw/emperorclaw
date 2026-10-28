import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildMcpInstructions } from "./instructions";
import { registerAgentTools } from "./tools/agents";
import { registerTaskTools } from "./tools/tasks";
import { registerProjectTools } from "./tools/projects";
import { registerKnowledgeTools } from "./tools/knowledge";
import { registerMessagingTools } from "./tools/messaging";
import { registerStorageTools } from "./tools/storage";
import { registerRequestTools } from "./tools/requests";
import { registerObjectiveTools } from "./tools/objectives";
import { registerViewTools } from "./tools/views";
import { registerActionPolicyTools } from "./tools/action-policies";
import { MCP_ACTOR_ARG_TOOLS, isActionKey } from "@/lib/action-policy";
import { enforceActionPolicy, type ActionDecision } from "@/lib/action-policy-server";
import { resolveAgentId } from "@/lib/mcp";
import { moduleForTool, type ModuleState } from "@/lib/modules";
import { loadCompanyModules } from "@/lib/modules-server";
import { jsonResult } from "./result";

/**
 * Route every governed tool through the agent's action permissions
 * (lib/action-policy-server.ts) before its handler runs. Done once here, at
 * registration, so no tool can forget it. The acting agent is the token's
 * bound agent, else (for the tools whose agentId names the actor) the agent an
 * operator connection names; with none, the company policy applies.
 */
function gateToolsByActionPolicy(server: McpServer, companyId: string, callerAgentId: string | null, tokenId: string | null) {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, handler: unknown) => {
        if (typeof name !== "string" || !isActionKey(name) || typeof handler !== "function") return register(name, config, handler);
        const run = handler as (...callArgs: unknown[]) => unknown;
        // The SDK passes (args, extra) to a tool with an input schema and just (extra) to one without.
        if (!(config as { inputSchema?: unknown } | null)?.inputSchema) {
            return register(name, config, async (extra: unknown) => {
                const decision = await enforceActionPolicy({ companyId, agentId: callerAgentId, tokenId, actionKey: name, args: {} });
                return decision.outcome === "allowed" ? run(extra) : refusal(decision);
            });
        }
        return register(name, config, async (args: Record<string, unknown>, extra: unknown) => {
            let agentId = callerAgentId;
            if (!agentId && MCP_ACTOR_ARG_TOOLS.has(name) && typeof args?.agentId === "string" && args.agentId.trim()) {
                agentId = await resolveAgentId(companyId, args.agentId).catch(() => null);
            }
            const decision = await enforceActionPolicy({ companyId, agentId, tokenId, actionKey: name, args: args ?? {} });
            return decision.outcome === "allowed" ? run(args, extra) : refusal(decision);
        });
    };
}

/**
 * Leave out the tools of a module the company switched off (lib/modules.ts
 * MODULE_TOOLS): they are not registered, so tools/list omits them and a call
 * is refused ("Tool … not found"). Installed after the action-policy gate, so
 * it runs first. The server is built per request, so a change applies at once.
 */
function omitToolsOfModulesOff(server: McpServer, modules: ModuleState) {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, ...rest: unknown[]) => {
        const key = typeof name === "string" ? moduleForTool(name) : null;
        if (key && !modules[key]) return undefined;
        return register(name, ...rest);
    };
}

/** What the agent gets instead of the tool's result: nothing ran, and why. */
function refusal(decision: Exclude<ActionDecision, { outcome: "allowed" }>) {
    const approvalId = "approvalId" in decision ? decision.approvalId : null;
    return {
        ...jsonResult({
            executed: false,
            status: decision.outcome === "pending" ? "approval_pending" : decision.outcome,
            action: decision.actionKey,
            approvalId,
            message: decision.message,
        }),
        isError: true,
    };
}

export async function buildMcpServer(companyId: string, callerAgentId?: string | null, tokenId?: string | null): Promise<McpServer> {
    const instructions = await buildMcpInstructions(companyId);

    const server = new McpServer(
        { name: "emperorclaw", version: "1.0.0" },
        { instructions, capabilities: { tools: {} } },
    );
    gateToolsByActionPolicy(server, companyId, callerAgentId ?? null, tokenId ?? null);
    omitToolsOfModulesOff(server, await loadCompanyModules(companyId));

    registerAgentTools(server, companyId, callerAgentId, tokenId ?? null);
    registerTaskTools(server, companyId, callerAgentId, tokenId ?? null);
    registerProjectTools(server, companyId, callerAgentId, tokenId ?? null);
    registerKnowledgeTools(server, companyId, callerAgentId, tokenId ?? null);
    registerStorageTools(server, companyId, callerAgentId);
    registerMessagingTools(server, companyId, callerAgentId);
    registerObjectiveTools(server, companyId, callerAgentId);
    registerViewTools(server, companyId, callerAgentId, tokenId ?? null);
    registerActionPolicyTools(server, companyId, callerAgentId, tokenId ?? null);
    // Handing work to an agent from outside is an operator action, not an agent one.
    if (!callerAgentId) registerRequestTools(server, companyId, tokenId ?? null);

    return server;
}
