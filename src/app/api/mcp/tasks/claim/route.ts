import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { taskEvents } from "@/db/schema";

export async function POST(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const endpoint = "/mcp/tasks/claim";

  const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
  if (error) return NextResponse.json({ error }, { status });
  if (cachedResponse) return NextResponse.json(cachedResponse);

  const { agentId } = await req.json();
  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  const internalAgentId = await resolveAgentId(companyId, agentId);

  // Atomic claim using CTE / sub-select with FOR UPDATE SKIP LOCKED
  const result = await db.execute(sql`
    UPDATE tasks
    SET 
      state = 'in_progress', 
      assigned_agent_id = ${internalAgentId},
      lease_owner = ${agentId},
      lease_until = NOW() + INTERVAL '2 minutes',
      updated_at = NOW()
    WHERE id = (
      SELECT t.id FROM tasks t
      WHERE t.company_id = ${companyId}
        AND t.state = 'queued'
        AND t.deleted_at IS NULL
        AND (
          jsonb_array_length(t.blocked_by_task_ids) = 0
          OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(t.blocked_by_task_ids) as blocked_id
            JOIN tasks b ON b.id = blocked_id::uuid
            WHERE b.state != 'done'
          )
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

  const res = { message: "Task claimed successfully", task };
  await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
  return NextResponse.json(res);
}
