import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { getScopedResource, leaseScopedResource, resolveResourceScope } from "@/lib/resources";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const companyId = auth.companyToken!.companyId;
    const { id } = await params;
    const body = await req.json();
    const internalAgentId = body.agentId ? await resolveAgentId(companyId, body.agentId) : null;

    const leasedResource = await leaseScopedResource({
      companyId,
      resourceId: id,
      agentId: internalAgentId,
      sessionId: body.sessionId || null,
      taskId: body.taskId || null,
      reason: body.reason || null,
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
      configJson: resource.configJson || {},
      secretJson: resource.secretJson || {},
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const statusCode =
      message.startsWith("Agent not found") || message.startsWith("Resource not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}
