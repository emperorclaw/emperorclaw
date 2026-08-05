import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listTasksForCompany, createTaskForProject, updateTaskForCompany, claimNextTaskForAgent } from "@/lib/openclaw/tasks";
import { getTaskDetailForCompany } from "@/lib/openclaw/task-context";
import { jsonResult, errorResult } from "../result";

export function registerTaskTools(server: McpServer, companyId: string) {
    server.registerTool("list_tasks", {
        title: "List Tasks",
        description: "List tasks for this company, optionally filtered by project or state.",
        inputSchema: {
            projectId: z.string().optional().describe("Restrict to a single project"),
            state: z.string().optional().describe("Task state, e.g. 'inbox', 'in_progress', 'done'"),
            limit: z.number().int().min(1).max(500).optional(),
        },
    }, async ({ projectId, state, limit }) => {
        try {
            const tasks = await listTasksForCompany({ companyId, limit: limit || 100, state, projectId });
            return jsonResult({ tasks });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("get_task", {
        title: "Get Task",
        description: "Get a single task's full detail, including its approval summary.",
        inputSchema: {
            taskId: z.string().describe("The task's UUID"),
        },
    }, async ({ taskId }) => {
        try {
            const task = await getTaskDetailForCompany(companyId, taskId);
            if (!task) return errorResult(new Error(`Task ${taskId} not found`));
            return jsonResult({ task });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("create_task", {
        title: "Create Task",
        description: "Create a new task under a project. Use claim_task if you want an agent to immediately pick up available work instead of assigning directly.",
        inputSchema: {
            projectId: z.string().describe("The project this task belongs to"),
            taskType: z.string().describe("Task type identifier, e.g. 'research', 'write_content', 'review'"),
            inputJson: z.record(z.string(), z.unknown()).optional().describe("Structured task input/spec"),
            priority: z.number().int().optional(),
            assignedAgentId: z.string().optional().describe("Agent id to assign this task to directly"),
        },
    }, async ({ projectId, taskType, inputJson, priority, assignedAgentId }) => {
        try {
            const { task } = await createTaskForProject({
                companyId, projectId, taskType, inputJson, priority, assignedAgentId,
                source: "mcp_server", actorType: "agent",
            });
            return jsonResult({ message: "Task created", task });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("update_task", {
        title: "Update Task",
        description: "Update a task's title, goal, priority, assignee, state, or input. Provide only the fields you want to change.",
        inputSchema: {
            taskId: z.string(),
            title: z.string().optional(),
            goal: z.string().optional(),
            priority: z.number().int().optional(),
            assignedAgentId: z.string().optional(),
            state: z.string().optional().describe("New task state, e.g. 'in_progress', 'done'"),
            inputJson: z.record(z.string(), z.unknown()).optional(),
        },
    }, async ({ taskId, title, goal, priority, assignedAgentId, state, inputJson }) => {
        try {
            const task = await updateTaskForCompany({ companyId, taskId, title, goal, priority, assignedAgentId, state, inputJson });
            return jsonResult({ message: "Task updated", task });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("claim_task", {
        title: "Claim Next Task",
        description: "Claim the next available unassigned task for an agent, respecting role/ownership rules. Use this for pull-based work distribution instead of create_task with a fixed assignee.",
        inputSchema: {
            agentId: z.string().describe("The agent claiming work"),
            strictOwnerRole: z.boolean().optional().describe("Restrict to tasks matching the agent's own role (default true)"),
        },
    }, async ({ agentId, strictOwnerRole }) => {
        try {
            const result = await claimNextTaskForAgent({ companyId, agentId, strictOwnerRole });
            return jsonResult(result);
        } catch (e) {
            return errorResult(e);
        }
    });
}
