import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listProjectsForCompany, getProjectForCompany, createProjectForCompany, updateProjectForCompany } from "@/lib/projects-crud";
import { jsonResult, errorResult } from "../result";

export function registerProjectTools(server: McpServer, companyId: string) {
    server.registerTool("list_projects", {
        title: "List Projects",
        description: "List projects for this company, most recently created first.",
        inputSchema: {
            status: z.string().optional().describe("Filter by status, e.g. 'active', 'paused', 'completed'"),
            limit: z.number().int().min(1).max(500).optional(),
        },
    }, async ({ status, limit }) => {
        try {
            const projects = await listProjectsForCompany({ companyId, status, limit });
            return jsonResult({ projects });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("get_project", {
        title: "Get Project",
        description: "Get a single project's full detail, including its linked customer.",
        inputSchema: {
            projectId: z.string(),
        },
    }, async ({ projectId }) => {
        try {
            const project = await getProjectForCompany(companyId, projectId);
            if (!project) return errorResult(new Error(`Project ${projectId} not found`));
            return jsonResult({ project });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("create_project", {
        title: "Create Project",
        description: "Create a new project. A project groups tasks under a shared goal and optional workflow rules.",
        inputSchema: {
            goal: z.string().min(1).describe("What this project is trying to achieve"),
            customerId: z.string().optional(),
            leadAgentId: z.string().optional(),
            requireApprovalForDone: z.boolean().optional(),
            maxActiveAgents: z.number().int().min(1).optional(),
        },
    }, async ({ goal, customerId, leadAgentId, requireApprovalForDone, maxActiveAgents }) => {
        try {
            const project = await createProjectForCompany({ companyId, goal, customerId, leadAgentId, requireApprovalForDone, maxActiveAgents });
            return jsonResult({ message: "Project created", project });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("update_project", {
        title: "Update Project",
        description: "Update a project's goal, status, or workflow rules. Provide only the fields you want to change.",
        inputSchema: {
            projectId: z.string(),
            goal: z.string().optional(),
            status: z.enum(["active", "paused", "killed", "completed"]).optional(),
            leadAgentId: z.string().optional(),
        },
    }, async ({ projectId, goal, status, leadAgentId }) => {
        try {
            const project = await updateProjectForCompany({ companyId, projectId, goal, status, leadAgentId });
            return jsonResult({ message: "Project updated", project });
        } catch (e) {
            return errorResult(e);
        }
    });
}
