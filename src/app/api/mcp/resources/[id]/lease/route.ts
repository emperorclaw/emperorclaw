import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveMcpActorContext } from "@/lib/mcp";
import { getScopedResource, leaseScopedResource, resolveResourceScope } from "@/lib/resources";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyMcpToken(req, { requiredScope: "mcp_danger" });
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const companyId = auth.companyToken!.companyId;
    const { id } = await params;
    const body = await req.json();
    const actor = await resolveMcpActorContext(companyId, {
      agentId: typeof body.agentId === "string" ? body.agentId : null,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
      taskId: typeof body.taskId === "string" ? body.taskId : null,
    });

    const leasedResource = await leaseScopedResource({
      companyId,
      resourceId: id,
      agentId: actor.callerAgentId,
      sessionId: body.sessionId || null,
      taskId: body.taskId || null,
      reason: body.reason || null,
      task: actor.task,
    });

    const resource = await getScopedResource(companyId, id);
    if (!resource || !leasedResource) {
      return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    }

    return NextResponse.json({
      resource: {
        ...leasedResource,
        ...resolveResourceScope(resource),
      },
      configText: resource.configText || "",
      secretText: resource.secretText || "",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const statusCode =
      message.startsWith("Agent not found") ||
      message.startsWith("Resource not found") ||
      message.startsWith("Session not found") ||
      message.startsWith("Task not found")
        ? 404
        : message.startsWith("Access denied")
          ? 403
          : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}
