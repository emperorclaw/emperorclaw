import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createAgentRequest, getAgentRequest, listAgentRequests } from "@/lib/agent-requests";
import { jsonResult, errorResult } from "../result";

/**
 * Operator connections (Claude, Codex, a platform's own MCP client) can hand a
 * request to one agent: it lands in the agent's direct chat from the named
 * source and is tracked as a task. Agents have create_task and send_message.
 */
export function registerRequestTools(server: McpServer, companyId: string, tokenId: string | null) {
    server.registerTool("send_agent_request", {
        title: "Send Request to Agent",
        description: "Hand a piece of work to one agent on behalf of an outside platform or person. The agent receives it in its direct chat, attributed to `source` (not to a company member), and it is tracked as a task assigned to that agent. Returns the request with its id and status; read it back with get_agent_request for the agent's reply and the task's state. Pass idempotencyKey to make retries safe.",
        inputSchema: {
            agent: z.string().describe("Agent id or name"),
            prompt: z.string().min(1).describe("What the agent should do, with everything it needs"),
            source: z.string().min(1).max(80).describe("Who is asking, shown to the agent, e.g. 'Acme Portal'"),
            title: z.string().max(120).optional().describe("Task title; defaults to the prompt's first line"),
            requestedBy: z.string().max(200).optional().describe("The person on whose behalf, e.g. their email"),
            externalRef: z.string().max(200).optional().describe("The id of this case in the other system"),
            idempotencyKey: z.string().max(200).optional(),
            projectId: z.string().optional().describe("Project for the task; defaults to 'Requests from <source>'"),
        },
    }, async (args) => {
        try {
            const { request, created } = await createAgentRequest({ companyId, tokenId, ...args });
            return jsonResult({ request, created });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("get_agent_request", {
        title: "Get Agent Request",
        description: "Status of requests sent with send_agent_request: queued, in_progress, waiting_approval, in_review, done, failed, or cancelled, with the agent's replies and the task's output. Pass requestId for one, or externalRef to find them by the other system's id.",
        inputSchema: {
            requestId: z.string().optional(),
            externalRef: z.string().optional(),
        },
    }, async ({ requestId, externalRef }) => {
        try {
            if (requestId) {
                const request = await getAgentRequest(companyId, requestId);
                return request ? jsonResult({ request }) : errorResult(new Error("Request not found"));
            }
            return jsonResult({ requests: await listAgentRequests(companyId, { externalRef: externalRef ?? null, limit: 20 }) });
        } catch (e) {
            return errorResult(e);
        }
    });
}
