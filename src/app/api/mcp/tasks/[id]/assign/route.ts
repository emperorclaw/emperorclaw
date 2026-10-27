import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { assignTaskToAgent } from "@/lib/openclaw/tasks";
import { serializeTaskWithAssignee } from "@/lib/task-assignee";
import { assertMcpMayAssign, mcpAccessErrorResponse, mcpMayUseTask, mcpRouteAccess } from "@/lib/mcp-access";
import { mcpActor } from "@/lib/audit";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const resolvedParams = await params;
  const companyId = auth.companyToken!.companyId;
  const taskId = resolvedParams.id;
  const endpoint = `/api/mcp/tasks/${taskId}/assign`;

  const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
  if (error) return NextResponse.json({ error }, { status });
  if (cachedResponse) return NextResponse.json(cachedResponse);

  const body = await req.json();
  const { agentId, mode = "assign" } = body;
  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  try {
    // The acting (bound) agent must be able to see the task it hands out; the
    // assignee's own scope is checked by assignTaskToAgent. In claim mode the
    // claimer is the actor, so a bound token may only claim for itself.
    const scoped = await mcpRouteAccess(companyId, auth.companyToken!, mode === "claim" ? agentId : null);
    if (scoped.response) return scoped.response;
    if (!(await mcpMayUseTask(companyId, scoped.access, taskId))) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    // Assigning to another agent: the acting (bound) agent must be able to reach it.
    const actor = await mcpRouteAccess(companyId, auth.companyToken!, null);
    if (actor.response) return actor.response;
    await assertMcpMayAssign(companyId, actor.access, { agentId });
    const result = await assignTaskToAgent({ companyId, taskId, agentId, mode, actorAgentId: auth.companyToken!.agentId ?? null, actor: mode === "claim" ? undefined : mcpActor(auth.companyToken!.agentId, auth.companyToken!.id) });
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    const res = { message: mode === "claim" ? "Task claimed successfully" : "Task assigned successfully", task: serializeTaskWithAssignee(result.task) };
    await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
    return NextResponse.json(res);
  } catch (error) {
    const denied = mcpAccessErrorResponse(error);
    if (denied) return denied;
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const status = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
