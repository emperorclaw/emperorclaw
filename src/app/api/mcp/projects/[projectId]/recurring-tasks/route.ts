import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import {
  createRecurringTaskDefinition,
  listRecurringTaskDefinitionsForProject,
} from "@/lib/openclaw/tasks";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const { projectId } = await params;

  try {
    const definitions = await listRecurringTaskDefinitionsForProject(companyId, projectId);
    return NextResponse.json({ recurringTasks: definitions });
  } catch (error) {
    console.error("Recurring task list error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const { projectId } = await params;
  const endpoint = `/api/mcp/projects/${projectId}/recurring-tasks`;

  const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
  if (error) return NextResponse.json({ error }, { status });
  if (cachedResponse) return NextResponse.json(cachedResponse);

  try {
    const body = await req.json();
    const {
      agentId,
      name,
      taskType,
      cronExpression,
      payloadJson,
      priority = 0,
      proofRequired = false,
      humanApprovalRequired = false,
      proofTypesJson = [],
      nextRunAt,
    } = body;

    if (!name || !taskType) {
      return NextResponse.json({ error: "name and taskType are required" }, { status: 400 });
    }

    const recurringTask = await createRecurringTaskDefinition({
      companyId,
      projectId,
      agentId: agentId || null,
      name,
      taskType,
      cronExpression: cronExpression || null,
      payloadJson: payloadJson || {},
      priority,
      proofRequired,
      humanApprovalRequired,
      proofTypesJson,
      nextRunAt: nextRunAt ? new Date(nextRunAt) : null,
    });

    const res = { message: "Recurring task created", recurringTask };
    await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
    return NextResponse.json(res, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const status = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
