import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult, errorResult } from "../result";
import { listAgentObjectives, readAgentObjective, updateObjectiveFromAgent } from "@/lib/agent-objective";
import { resolveAgentId } from "@/lib/mcp";

/**
 * The authenticated objective tool. A bound agent token can only act on its own
 * objectives: `callerAgentId` wins, and the service enforces (company, agent)
 * ownership again. An operator connection (no bound agent) must name an agent.
 */
export function registerObjectiveTools(server: McpServer, companyId: string, callerAgentId?: string | null) {
    server.registerTool("list_objectives", {
        title: "List Objectives",
        description: "List your persistent objectives, most recent first. An objective is the durable outcome you were asked to pursue; Emperor sends you a private check-in on a fixed cadence until you complete, block, pause or cancel it.",
        inputSchema: {
            agentId: z.string().optional().describe("Agent id or name (operator connections only)"),
        },
    }, async ({ agentId }) => {
        try {
            const agent = callerAgentId ?? (agentId ? await resolveAgentId(companyId, agentId) : null);
            if (!agent) return errorResult(new Error("agentId is required"));
            const { objective } = await readAgentObjective(companyId, agent);
            return jsonResult({ objective, objectives: await listAgentObjectives(companyId, agent) });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("update_objective", {
        title: "Update Objective",
        description: "Report on or change your own objective. Actions: 'update' (with a short summary of progress), 'block' (requires blockerReason and pauses check-ins until you resume), 'resume', 'pause', 'complete' (requires completionSummary), 'cancel'. You can only update objectives you own.",
        inputSchema: {
            objectiveId: z.string().describe("The objective's UUID"),
            action: z.enum(["update", "pause", "resume", "block", "complete", "cancel"]),
            summary: z.string().optional().describe("One-line progress note for action 'update'"),
            blockerReason: z.string().optional().describe("What you are waiting on (required for action 'block')"),
            completionSummary: z.string().optional().describe("What was delivered (for action 'complete')"),
            objective: z.string().optional().describe("Replace the objective text (action 'update')"),
            cadenceMinutes: z.number().int().min(5).max(10080).optional().describe("Change the check-in cadence in minutes (action 'update')"),
            agentId: z.string().optional().describe("Agent id or name (operator connections only)"),
        },
    }, async ({ objectiveId, action, summary, blockerReason, completionSummary, objective, cadenceMinutes, agentId }) => {
        try {
            const agent = callerAgentId ?? (agentId ? await resolveAgentId(companyId, agentId) : null);
            if (!agent) return errorResult(new Error("agentId is required"));
            const updated = await updateObjectiveFromAgent(companyId, agent, {
                objectiveId, action, summary, blockerReason, completionSummary, objective, cadenceMinutes,
            });
            return jsonResult({ message: "Objective updated", objective: updated });
        } catch (e) {
            return errorResult(e);
        }
    });
}
