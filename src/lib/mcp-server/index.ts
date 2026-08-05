import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildMcpInstructions } from "./instructions";
import { registerAgentTools } from "./tools/agents";
import { registerTaskTools } from "./tools/tasks";
import { registerProjectTools } from "./tools/projects";
import { registerKnowledgeTools } from "./tools/knowledge";
import { registerMessagingTools } from "./tools/messaging";

export async function buildMcpServer(companyId: string): Promise<McpServer> {
    const instructions = await buildMcpInstructions(companyId);

    const server = new McpServer(
        { name: "emperorclaw", version: "1.0.0" },
        { instructions, capabilities: { tools: {} } },
    );

    registerAgentTools(server, companyId);
    registerTaskTools(server, companyId);
    registerProjectTools(server, companyId);
    registerKnowledgeTools(server, companyId);
    registerMessagingTools(server, companyId);

    return server;
}
