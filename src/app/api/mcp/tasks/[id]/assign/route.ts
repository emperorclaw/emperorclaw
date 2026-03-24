import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { assignTaskToAgent } from "@/lib/openclaw/tasks";

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
    const result = await assignTaskToAgent({ companyId, taskId, agentId, mode });
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    const res = { message: mode === "claim" ? "Task claimed successfully" : "Task assigned successfully", task: result.task };
    await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
    return NextResponse.json(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const status = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
