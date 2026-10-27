import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listProjectsForCompany, getProjectForCompany, createProjectForCompany, updateProjectForCompany } from "@/lib/projects-crud";
import { jsonResult, errorResult } from "../result";
import { assertMcpMayReachAgent, mcpAccessForAgent, mcpMayUseCustomer, mcpMayUseProject } from "@/lib/mcp-access";
import { mcpActor } from "@/lib/audit";

export function registerProjectTools(server: McpServer, companyId: string, callerAgentId?: string | null, tokenId: string | null = null) {
    // Every project tool runs under the bound agent's data scope (lib/mcp-access.ts).
    const access = () => mcpAccessForAgent(companyId, callerAgentId ?? null);
    const requireProject = async (projectId: string) => {
        if (!mcpMayUseProject(await access(), projectId)) throw new Error(`Project ${projectId} not found`);
    };
    server.registerTool("list_projects", {
        title: "List Projects",
        description: "List projects for this company, most recently created first.",
        inputSchema: {
            status: z.string().optional().describe("Filter by status, e.g. 'active', 'paused', 'completed'"),
            limit: z.number().int().min(1).max(500).optional(),
        },
    }, async ({ status, limit }) => {
        try {
            const projects = await listProjectsForCompany({ companyId, status, limit, projectIdFilter: (await access()).allowedProjectIds });
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
            const project = mcpMayUseProject(await access(), projectId) ? await getProjectForCompany(companyId, projectId) : null;
            if (!project) return errorResult(new Error(`Project ${projectId} not found`));
            return jsonResult({ project });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("create_project", {
        title: "Create Project",
        description: "Create a new project. A project groups tasks under a shared outcome and optional workflow rules. Reuse an existing project when the work serves the same outcome. `goal` is the short name people see on the board; put what the project is for in `description`.",
        inputSchema: {
            goal: z.string().min(1).describe("Project name shown on the board: 2-6 words, at most 60 characters, no dashes or explanations (\"Harbor Dental website relaunch\"). Longer names are split automatically and the rest is saved as a project note."),
            description: z.string().optional().describe("What the project is for, in one or two plain sentences: client, outcome, scope. Saved as a project note every agent on the project sees."),
            customerId: z.string().optional(),
            leadAgentId: z.string().optional(),
            requireApprovalForDone: z.boolean().optional(),
            maxActiveAgents: z.number().int().min(1).optional(),
        },
    }, async ({ goal, description, customerId, leadAgentId, requireApprovalForDone, maxActiveAgents }) => {
        try {
            if (customerId && !mcpMayUseCustomer(await access(), customerId)) throw new Error(`Customer ${customerId} not found`);
            await assertMcpMayReachAgent(companyId, await access(), leadAgentId);
            const project = await createProjectForCompany({ companyId, goal, description, createdByAgentId: callerAgentId ?? null, customerId, leadAgentId, requireApprovalForDone, maxActiveAgents, actor: mcpActor(callerAgentId, tokenId) });
            return jsonResult({ message: "Project created", project });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("update_project", {
        title: "Update Project",
        description: "Update a project's name, status, or lead. Provide only the fields you want to change. To shorten an overlong name, pass a short `goal` and move the explanation to `description`.",
        inputSchema: {
            projectId: z.string(),
            goal: z.string().optional().describe("New short name: 2-6 words, at most 60 characters"),
            description: z.string().optional().describe("What the project is for; saved as a project note"),
            status: z.enum(["active", "paused", "killed", "completed"]).optional(),
            leadAgentId: z.string().optional(),
        },
    }, async ({ projectId, goal, description, status, leadAgentId }) => {
        try {
            await requireProject(projectId);
            await assertMcpMayReachAgent(companyId, await access(), leadAgentId);
            const project = await updateProjectForCompany({ companyId, projectId, goal, description, createdByAgentId: callerAgentId ?? null, status, leadAgentId, actor: mcpActor(callerAgentId, tokenId) });
            return jsonResult({ message: "Project updated", project });
        } catch (e) {
            return errorResult(e);
        }
    });
}
