import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { getTaskContextForCompany } from "@/lib/openclaw/task-context";
import { serializeTaskWithAssignee } from "@/lib/task-assignee";
import { mcpMayUseProject, mcpRouteAccess } from "@/lib/mcp-access";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const { id: taskId } = await params;

  try {
    const scoped = await mcpRouteAccess(companyId, auth.companyToken!, req.nextUrl.searchParams.get("agentId"));
    if (scoped.response) return scoped.response;
    const context = await getTaskContextForCompany(companyId, taskId, scoped.access);
    if (!context || !mcpMayUseProject(scoped.access, context.task.projectId)) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    return NextResponse.json({
      ...context,
      task: serializeTaskWithAssignee(context.task),
    }, { status: 200 });
  } catch (error) {
    console.error(`Error fetching task context ${taskId}:`, error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
