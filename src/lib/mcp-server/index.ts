import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildMcpInstructions } from "./instructions";
import { registerAgentTools } from "./tools/agents";
import { registerTaskTools } from "./tools/tasks";
import { registerProjectTools } from "./tools/projects";
import { registerKnowledgeTools } from "./tools/knowledge";
import { registerMessagingTools } from "./tools/messaging";
import { registerStorageTools } from "./tools/storage";
import { registerRequestTools } from "./tools/requests";

export async function buildMcpServer(companyId: string, callerAgentId?: string | null, tokenId?: string | null): Promise<McpServer> {
    const instructions = await buildMcpInstructions(companyId);

    const server = new McpServer(
        { name: "emperorclaw", version: "1.0.0" },
        { instructions, capabilities: { tools: {} } },
    );

    registerAgentTools(server, companyId, callerAgentId);
    registerTaskTools(server, companyId, callerAgentId);
    registerProjectTools(server, companyId);
    registerKnowledgeTools(server, companyId);
    registerStorageTools(server, companyId);
    registerMessagingTools(server, companyId, callerAgentId);
    // Handing work to an agent from outside is an operator action, not an agent one.
    if (!callerAgentId) registerRequestTools(server, companyId, tokenId ?? null);

    return server;
}
