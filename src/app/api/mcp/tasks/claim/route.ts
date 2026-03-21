import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { agents, taskEvents } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { TASK_STATES } from "@/lib/task-state";
import { broadcastMcpEvent } from "@/lib/pubsub";

export async function POST(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const endpoint = "/api/mcp/tasks/claim";

  const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
  if (error) return NextResponse.json({ error }, { status });
  if (cachedResponse) return NextResponse.json(cachedResponse);

  const { agentId, strictOwnerRole = true, allowedRoles = [] } = await req.json();
  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  let internalAgentId: string;
  try {
    internalAgentId = await resolveAgentId(companyId, agentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent not found";
    return NextResponse.json({ error: message }, { status: 404 });
  }

  const [agent] = await db.select({ role: agents.role }).from(agents).where(
    and(eq(agents.companyId, companyId), eq(agents.id, internalAgentId))
  ).limit(1);
  const agentRole = agent?.role || null;

  if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
    if (!agentRole || !allowedRoles.includes(agentRole)) {
      const res = { message: "No tasks available for this role policy" };
      await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
      return NextResponse.json(res);
    }
  }

  // Atomic claim using CTE / sub-select with FOR UPDATE SKIP LOCKED
  // Enforce ownerRole affinity when input_json.ownerRole is provided.
  const result = await db.execute(sql`
    UPDATE tasks
    SET 
      state = ${TASK_STATES.inProgress},
      assigned_agent_id = ${internalAgentId},
      lease_owner = ${agentId},
      lease_until = NOW() + INTERVAL '10 minutes',
      processing_started_at = NOW(),
      updated_at = NOW()
    WHERE id = (
      SELECT t.id FROM tasks t
      WHERE t.company_id = ${companyId}
        AND t.state = ${TASK_STATES.inbox}
        AND t.deleted_at IS NULL
        AND (
          ${strictOwnerRole === false} = true
          OR COALESCE(t.input_json->>'ownerRole', '') = ''
          OR t.input_json->>'ownerRole' = COALESCE(${agentRole}, '')
        )
        AND (
          jsonb_array_length(t.blocked_by_task_ids) = 0
          OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(t.blocked_by_task_ids) as blocked_id
            JOIN tasks b ON b.id = blocked_id::uuid
            WHERE b.state != 'done'
          )
        )
        AND (
          COALESCE((
            SELECT COUNT(DISTINCT t2.assigned_agent_id)
            FROM tasks t2
            WHERE t2.company_id = t.company_id
              AND t2.project_id = t.project_id
              AND t2.state = ${TASK_STATES.inProgress}
              AND t2.assigned_agent_id IS NOT NULL
          ), 0) < COALESCE((
            SELECT p.max_active_agents
            FROM projects p
            WHERE p.id = t.project_id
          ), 9999)
        )
      ORDER BY t.priority DESC, t.created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *;
  `);

  if (!result.rows || result.rows.length === 0) {
    const res = { message: "No tasks available" };
    await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
    return NextResponse.json(res);
  }

  const task = result.rows[0];

  // Log to task_events
  await db.insert(taskEvents).values({
    companyId,
    taskId: task.id as string,
    eventType: 'task_claimed',
    actorType: 'agent',
    actorId: internalAgentId,
  });

  await broadcastMcpEvent(companyId, { type: 'task_updated', task });

  const res = { message: "Task claimed successfully", task };
  await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
  return NextResponse.json(res);
}
