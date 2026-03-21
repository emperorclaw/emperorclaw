import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import {
  archiveRecurringTaskDefinition,
  updateRecurringTaskDefinition,
} from "@/lib/openclaw/tasks";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; recurringTaskId: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const { projectId, recurringTaskId } = await params;
  const endpoint = `/api/mcp/projects/${projectId}/recurring-tasks/${recurringTaskId}`;

  const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
  if (error) return NextResponse.json({ error }, { status });
  if (cachedResponse) return NextResponse.json(cachedResponse);

  try {
    const body = await req.json();
    const recurringTask = await updateRecurringTaskDefinition({
      companyId,
      projectId,
      recurringTaskId,
      patch: {
        name: body.name,
        taskType: body.taskType,
        cronExpression: body.cronExpression,
        payloadJson: body.payloadJson,
        priority: body.priority,
        proofRequired: body.proofRequired,
        humanApprovalRequired: body.humanApprovalRequired,
        proofTypesJson: body.proofTypesJson,
        active: body.active,
        nextRunAt: body.nextRunAt ? new Date(body.nextRunAt) : body.nextRunAt,
      },
    });

    if (!recurringTask) {
      return NextResponse.json({ error: "Recurring task definition not found" }, { status: 404 });
    }

    const res = { message: "Recurring task updated", recurringTask };
    await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
    return NextResponse.json(res);
  } catch (error) {
    console.error("Recurring task update error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; recurringTaskId: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const { projectId, recurringTaskId } = await params;
  const endpoint = `/api/mcp/projects/${projectId}/recurring-tasks/${recurringTaskId}`;

  const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
  if (error) return NextResponse.json({ error }, { status });
  if (cachedResponse) return NextResponse.json(cachedResponse);

  const recurringTask = await archiveRecurringTaskDefinition(companyId, projectId, recurringTaskId);
  if (!recurringTask) {
    return NextResponse.json({ error: "Recurring task definition not found" }, { status: 404 });
  }

  const res = { message: "Recurring task archived", recurringTask };
  await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
  return NextResponse.json(res);
}
