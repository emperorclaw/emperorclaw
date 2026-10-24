import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listTasksForCompany, createTaskForProject, updateTaskForCompany, claimNextTaskForAgent, getTaskOverviewForCompany, addTaskNote } from "@/lib/openclaw/tasks";
import { getTaskDetailForCompany } from "@/lib/openclaw/task-context";
import { jsonResult, errorResult } from "../result";
import { requestApprovalForTasks } from "@/lib/approvals";
import { resolveAgentId } from "@/lib/mcp";
import { BOUND_AGENT_MISMATCH, assertMcpMayAssign, mcpAccessForAgent, mcpMayUseProject, mcpMayUseTask } from "@/lib/mcp-access";

export function registerTaskTools(server: McpServer, companyId: string, callerAgentId?: string | null) {
    // Every task tool runs under the bound agent's data scope (lib/mcp-access.ts).
    const access = () => mcpAccessForAgent(companyId, callerAgentId ?? null);
    const requireTask = async (taskId: string) => {
        if (!(await mcpMayUseTask(companyId, await access(), taskId))) throw new Error(`Task ${taskId} not found`);
    };
    const requireProject = async (projectId: string) => {
        if (!mcpMayUseProject(await access(), projectId)) throw new Error(`Project ${projectId} not found`);
    };
    server.registerTool("request_approval", {
        title: "Request Approval",
        description: "Ask a person to sign off before you act: spending money, sending anything outside the company (emails, posts, messages with customers), publishing, deleting, or closing a task that requires approval. Moves the task to review and notifies owners and admins; the decision and the person's note arrive in your direct chat. Status meanings: approved task_done closes the task; any other approved action comes back in_progress for you to do and then close; rejected comes back in_progress with the reason to revise; dismissed means the request is obsolete — DO NOT ACT; expired (an external action left pending more than 48h) means DO NOT ACT, ask again if still needed. Don't ask in chat instead, and don't act unless the response says mayProceed (approved).",
        inputSchema: {
            taskId: z.string().describe("The task this approval is for"),
            rationale: z.string().min(1).describe("What exactly needs approval and why, with the evidence a person needs to decide"),
            actionType: z.string().optional().describe("e.g. task_done (default), send_email, spend, publish, delete"),
            agentId: z.string().optional().describe("Requesting agent id or name (operator connections only)"),
        },
    }, async ({ taskId, rationale, actionType, agentId }) => {
        try {
            await requireTask(taskId);
            const requester = callerAgentId ?? (agentId ? await resolveAgentId(companyId, agentId) : null);
            const approval = await requestApprovalForTasks({ companyId, taskIds: [taskId], requesterAgentId: requester, rationale, actionType });
            return jsonResult({ approval, status: "pending", next: "Wait for the decision; check it with get_task." });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("get_task_overview", {
        title: "Get Task Overview",
        description: "Return a compact, server-side status summary: totals by state plus the highest-priority, blocked, and approval-required tasks. Use this first for status questions; use get_task only for a selected task's full detail.",
        inputSchema: {
            projectId: z.string().optional().describe("Restrict to one project"),
            maxItems: z.number().int().min(1).max(25).optional().describe("Maximum compact items per section (default 10)"),
        },
    }, async ({ projectId, maxItems }) => {
        try {
            if (projectId) await requireProject(projectId);
            const projectIdFilter = (await access()).allowedProjectIds;
            return jsonResult({ overview: await getTaskOverviewForCompany({ companyId, projectId, maxItems, projectIdFilter }) });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("list_tasks", {
        title: "List Tasks",
        description: "List a small page of tasks for this company. For a status question, filter by state first; use get_task for full detail. Do not use this as a full-company export.",
        inputSchema: {
            projectId: z.string().optional().describe("Restrict to a single project"),
            state: z.string().optional().describe("Task state, e.g. 'inbox', 'in_progress', 'done'"),
            limit: z.number().int().min(1).max(50).optional().describe("Small page size (default 25, max 50). Filter by state or project before requesting more."),
        },
    }, async ({ projectId, state, limit }) => {
        try {
            if (projectId) await requireProject(projectId);
            const projectIdFilter = (await access()).allowedProjectIds;
            const tasks = await listTasksForCompany({ companyId, limit: limit || 25, state, projectId, projectIdFilter: projectId ? null : projectIdFilter });
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
            if (!task || !mcpMayUseProject(await access(), task.projectId)) return errorResult(new Error(`Task ${taskId} not found`));
            return jsonResult({ task });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("create_task", {
        title: "Create Task",
        description: "Create a new task under a project. Every task should have exactly one owner: pass `assignee` to assign the responsible agent or human (or assignedAgentId for agents only). The assignee is accountable for closing it. Use claim_task instead when you want an agent to pick up unassigned work. Write it for a busy person: inputJson.title is a short imperative outcome (at most 80 characters, no IDs or jargon, e.g. \"Publish the spring menu landing page\"); inputJson.description is Markdown with ## Goal, ## Context, ## Done when (a - [ ] checklist) and ## Links, in the language the people in this company use.",
        inputSchema: {
            projectId: z.string().describe("The project this task belongs to"),
            taskType: z.string().describe("Task type identifier, e.g. 'research', 'write_content', 'review'"),
            inputJson: z.record(z.string(), z.unknown()).optional().describe("Task content: { title: short imperative outcome, at most 80 chars; description: Markdown with Goal / Context / Done when (checklist) / Links; acceptanceCriteria?: string[]; deliverables?: string[] }"),
            priority: z.number().int().optional(),
            assignee: z.object({
                type: z.enum(["agent", "human"]),
                id: z.string().describe("Agent id, or a company membership/user id for a human"),
            }).nullable().optional().describe("The single owner responsible for closing this task"),
            assignedAgentId: z.string().optional().describe("Agent id to assign this task to directly (agent-only shorthand for assignee)"),
        },
    }, async ({ projectId, taskType, inputJson, priority, assignee, assignedAgentId }) => {
        try {
            await requireProject(projectId);
            await assertMcpMayAssign(companyId, await access(), { assignee, assignedAgentId });
            const { task } = await createTaskForProject({
                companyId, projectId, taskType, inputJson, priority, assignee, assignedAgentId,
                source: "mcp_server", actorType: "agent", actorId: callerAgentId ?? null,
            });
            return jsonResult({ message: "Task created", task });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("update_task", {
        title: "Update Task",
        description: "Update a task's title, goal, priority, assignee, state, or input. Provide only the fields you want to change. Reassign explicitly with `assignee`; the assignee closes the task. To hold work you cannot progress, set state 'blocked' with a blockedReason naming what you are waiting on; this stops automatic stalled reminders. Unblock by setting state back to 'in_progress' (the reason is cleared and the progress clock restarts).",
        inputSchema: {
            taskId: z.string(),
            title: z.string().optional().describe("Short imperative outcome, at most 80 characters, no IDs or jargon"),
            goal: z.string().optional(),
            priority: z.number().int().optional(),
            assignee: z.object({
                type: z.enum(["agent", "human"]),
                id: z.string().describe("Agent id, or a company membership/user id for a human"),
            }).nullable().optional().describe("The single owner responsible for closing this task; null unassigns"),
            assignedAgentId: z.string().optional(),
            state: z.string().optional().describe("New task state: 'inbox', 'in_progress', 'review', 'blocked', 'done', or 'failed'. Setting 'blocked' requires blockedReason."),
            blockedReason: z.string().optional().describe("Why the task is blocked (required for state 'blocked'; ignored otherwise). Use a short, specific reason naming the person or dependency you are waiting on."),
            inputJson: z.record(z.string(), z.unknown()).optional(),
        },
    }, async ({ taskId, title, goal, priority, assignee, assignedAgentId, state, blockedReason, inputJson }) => {
        try {
            await requireTask(taskId);
            await assertMcpMayAssign(companyId, await access(), { assignee, assignedAgentId });
            const task = await updateTaskForCompany({ companyId, taskId, title, goal, priority, assignee, assignedAgentId, state, blockedReason, inputJson, actorType: "agent", actorId: callerAgentId ?? null });
            return jsonResult({ message: "Task updated", task });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("add_task_note", {
        title: "Add Task Note",
        description: "Record progress, a handoff, or a blocker on a task. This is the visible progress signal: it resets the loop guard and the stall sweep, so note what you actually did or what is blocking you. Use update_task for state/assignee changes, not notes. Write for a business reader in at most ~8 lines of Markdown: what changed, the evidence (numbers, links, artifact IDs), and the next step. Put technical detail under a final **Details** line.",
        inputSchema: {
            taskId: z.string().describe("The task's UUID"),
            note: z.string().min(1).describe("Markdown, at most ~8 lines: what changed, evidence (numbers, links), next step or blocker. Plain language; technical detail last under **Details**."),
            kind: z.enum(["progress", "handoff", "blocker"]).optional().describe("The kind of note (default progress)"),
            agentId: z.string().optional().describe("Requesting agent id or name (operator connections only)"),
        },
    }, async ({ taskId, note, kind, agentId }) => {
        try {
            const actorAgentId = callerAgentId ?? (agentId ? await resolveAgentId(companyId, agentId) : null);
            const event = await addTaskNote({ companyId, taskId, note, kind: kind ?? "progress", actorAgentId });
            return jsonResult({ message: "Note added", event });
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
            // A bound connection claims only for its own agent.
            if (callerAgentId && (await resolveAgentId(companyId, agentId)) !== callerAgentId) throw new Error(BOUND_AGENT_MISMATCH);
            const result = await claimNextTaskForAgent({ companyId, agentId, strictOwnerRole });
            return jsonResult(result);
        } catch (e) {
            return errorResult(e);
        }
    });
}
