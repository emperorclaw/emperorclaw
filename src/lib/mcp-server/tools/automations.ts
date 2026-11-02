import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, pipelines } from "@/db/schema";
import { jsonResult, errorResult } from "../result";
import { assertMcpMayReachAgent, isMcpAccessRestricted, mcpAccessForAgent, mcpMayUseProject, mcpMayUseRecord, mcpRecordCondition } from "@/lib/mcp-access";
import { mcpActor } from "@/lib/audit";
import { companyTimezone, PipelineRunError, startPipelineRun } from "@/lib/pipeline-runs";
import { computeNextRunAt, cronExpression, describeCron, scheduleTimezone } from "@/lib/pipeline-schedule";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Automations (the pipelines registry) for operators and agents: see what is
 * registered and when it runs next, and start one now. run_automation uses the
 * same run service as Run now in the app (lib/pipeline-runs.ts).
 */
export function registerAutomationTools(server: McpServer, companyId: string, callerAgentId?: string | null, tokenId: string | null = null) {
    const access = () => mcpAccessForAgent(companyId, callerAgentId ?? null);

    server.registerTool("list_automations", {
        title: "List Automations",
        description: "List the automations (registered pipelines) you can see: status, the agent that runs each one, its trigger, who fires the schedule (the agent's runtime or Emperor), when it runs next, and its last run.",
        inputSchema: {
            status: z.enum(["draft", "active", "paused"]).optional(),
            limit: z.number().int().min(1).max(200).optional(),
        },
    }, async ({ status, limit }) => {
        try {
            const scope = mcpRecordCondition(await access(), { projectId: pipelines.projectId, customerId: pipelines.customerId });
            const rows = await db.select().from(pipelines).where(and(
                eq(pipelines.companyId, companyId), isNull(pipelines.deletedAt),
                status ? eq(pipelines.status, status) : undefined, scope,
            )).orderBy(desc(pipelines.updatedAt)).limit(limit ?? 100);
            const agentIds = [...new Set(rows.map((r) => r.ownerAgentId).filter((id): id is string => Boolean(id)))];
            const names = agentIds.length > 0
                ? new Map((await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))).map((a) => [a.id, a.name]))
                : new Map<string, string>();
            const companyTz = await companyTimezone(companyId);
            const now = new Date();
            return jsonResult({
                automations: rows.map((row) => {
                    const cron = row.trigger === "cron" ? cronExpression(row.triggerConfig) : null;
                    const next = row.scheduledBy === "emperor" && row.nextRunAt ? row.nextRunAt : computeNextRunAt(row, companyTz, now);
                    return {
                        id: row.id,
                        name: row.name,
                        purpose: row.purpose,
                        status: row.status,
                        runner: row.ownerAgentId ? { id: row.ownerAgentId, name: names.get(row.ownerAgentId) ?? null } : null,
                        trigger: row.trigger,
                        triggerConfig: row.triggerConfig,
                        schedule: cron ? { cron, description: describeCron(cron), timezone: scheduleTimezone(row.triggerConfig, companyTz), scheduledBy: row.scheduledBy } : null,
                        nextRunAt: row.status === "active" ? next?.toISOString() ?? null : null,
                        lastRun: row.lastRunAt ? { at: row.lastRunAt.toISOString(), status: row.lastRunStatus } : null,
                        runCount: row.runCount,
                    };
                }),
            });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("run_automation", {
        title: "Run Automation",
        description: "Run an active automation once, now. Emperor records a run and gives the runner agent (the automation's own, or `agentId`) a task with the steps and the runId to report back with. Refused while the automation is paused or a draft, or while a run is still running unless `force` is true.",
        inputSchema: {
            automationId: z.string().describe("The automation's id, or its exact name"),
            agentId: z.string().optional().describe("Agent id or name to run it instead of the automation's own agent"),
            force: z.boolean().optional().describe("Start another run even though one is still running"),
        },
    }, async ({ automationId, agentId, force }) => {
        try {
            const scope = await access();
            const [pipeline] = await db.select().from(pipelines).where(and(
                eq(pipelines.companyId, companyId), isNull(pipelines.deletedAt),
                UUID_RE.test(automationId) ? eq(pipelines.id, automationId) : eq(pipelines.name, automationId),
            )).limit(1);
            if (!pipeline || !mcpMayUseRecord(scope, pipeline)) throw new Error(`Automation not found: ${automationId}`);
            await assertMcpMayReachAgent(companyId, scope, agentId ?? pipeline.ownerAgentId);
            const started = await startPipelineRun({
                companyId,
                pipelineId: pipeline.id,
                agentRef: agentId ?? null,
                force: force === true,
                source: "api",
                triggeredBy: callerAgentId ? { type: "agent", id: callerAgentId } : null,
                actor: mcpActor(callerAgentId, tokenId),
                // A restricted agent adds work only to its projects; a new "General" project is not one of them.
                mayUseProject: async (projectId) => projectId ? mcpMayUseProject(scope, projectId) : !isMcpAccessRestricted(scope),
            });
            return jsonResult({ message: "Run started", run: started.run, taskId: started.taskId, agentId: started.agentId });
        } catch (e) {
            if (e instanceof PipelineRunError) {
                return errorResult(new Error(e.run ? `${e.message} Run ${e.run.id} started ${e.run.startedAt.toISOString()}; pass force: true to start another.` : e.message));
            }
            return errorResult(e);
        }
    });
}
