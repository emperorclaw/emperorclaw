import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { spawnRecurringTaskInstance } from "@/lib/openclaw/tasks";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; recurringTaskId: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const { projectId, recurringTaskId } = await params;
  const endpoint = `/api/mcp/projects/${projectId}/recurring-tasks/${recurringTaskId}/spawn`;

  const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
  if (error) return NextResponse.json({ error }, { status });
  if (cachedResponse) return NextResponse.json(cachedResponse);

  try {
    const { task, definition } = await spawnRecurringTaskInstance({
      companyId,
      projectId,
      recurringTaskId,
      source: "manual_recurring_spawn",
    });

    const res = { message: "Recurring task spawned", recurringTask: definition, task };
    await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
    return NextResponse.json(res, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const status = message === "Recurring task definition not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
