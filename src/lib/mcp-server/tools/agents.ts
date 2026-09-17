import { hireHermesAgent } from "@/lib/hire-hermes-agent";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listAgentsForCompany, getAgentForCompany, createAgentForCompany, updateAgentForCompany } from "@/lib/agents-crud";
import { jsonResult, errorResult } from "../result";

export function registerAgentTools(server: McpServer, companyId: string, callerAgentId?: string | null) {
    server.registerTool("list_agents", {
        title: "List Agents",
        description: "List agents registered for this company, most recently created first.",
        inputSchema: {
            limit: z.number().int().min(1).max(500).optional().describe("Max agents to return (default 100, max 500)"),
        },
    }, async ({ limit }) => {
        try {
            const agents = await listAgentsForCompany({ companyId, limit });
            return jsonResult({ agents });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("get_agent", {
        title: "Get Agent",
        description: "Get a single agent's full record by id.",
        inputSchema: {
            agentId: z.string().describe("The agent's UUID"),
        },
    }, async ({ agentId }) => {
        try {
            const agent = await getAgentForCompany(companyId, agentId);
            if (!agent) return errorResult(new Error(`Agent ${agentId} not found`));
            return jsonResult({ agent });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("create_agent", {
        title: "Create Agent",
        description: "Register a new agent for this company, or provision a running local Hermes worker with deploymentMode=local and sourceAgentId. Use this to add a new AI worker to the roster — not for the human operator's own account.",
        inputSchema: {
            deploymentMode: z.enum(["remote", "local"]).optional(),
            sourceAgentId: z.string().uuid().optional().describe("Hermes agent whose stored LLM configuration to reuse for local hiring; credentials stay server-side"),
            doctrineJson: z.record(z.string(), z.string()).optional(),
            name: z.string().min(1).describe("Agent display name"),
            role: z.string().optional().describe("Agent role, e.g. 'operator', 'QA', 'Growth'"),
            skillsJson: z.array(z.unknown()).optional().describe("List of skill identifiers this agent has"),
            llmProvider: z.string().optional().describe("LLM provider, e.g. 'openai', 'anthropic'"),
            llmModel: z.string().optional().describe("Specific model id, e.g. 'gpt-4o-mini'"),
        },
    }, async ({ name, role, skillsJson, llmProvider, llmModel, deploymentMode, sourceAgentId, doctrineJson }) => {
        try {
            if (deploymentMode === "local") {
                sourceAgentId = callerAgentId || sourceAgentId;
                if (!sourceAgentId) throw new Error("sourceAgentId is required for local Hermes hiring");
                return jsonResult(await hireHermesAgent({ companyId, name, role, sourceAgentId, doctrineJson }));
            }
            const agent = await createAgentForCompany({ companyId, name, role, skillsJson, llmProvider, llmModel, actorType: "mcp" });
            return jsonResult({ message: "Agent registered", agent });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("update_agent", {
        title: "Update Agent",
        description: "Update an existing agent's role, skills, or LLM configuration. Provide only the fields you want to change.",
        inputSchema: {
            agentId: z.string().describe("The agent's UUID"),
            name: z.string().optional(),
            role: z.string().optional(),
            skillsJson: z.array(z.unknown()).optional(),
            llmProvider: z.string().optional(),
            llmModel: z.string().optional(),
        },
    }, async ({ agentId, name, role, skillsJson, llmProvider, llmModel }) => {
        try {
            const agent = await updateAgentForCompany({ companyId, agentId, name, role, skillsJson, llmProvider, llmModel });
            return jsonResult({ message: "Agent updated", agent });
        } catch (e) {
            return errorResult(e);
        }
    });
}
