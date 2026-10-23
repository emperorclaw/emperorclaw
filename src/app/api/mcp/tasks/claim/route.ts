import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { ensureTeamThread } from "@/lib/control-plane";
import { claimNextTaskForAgent } from "@/lib/openclaw/tasks";
import { mcpRouteAccess } from "@/lib/mcp-access";

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

  const { agentId: requestedAgentId, strictOwnerRole = true, allowedRoles = [] } = await req.json();
  // A bound token claims only for its own agent (whose scope then applies).
  const scoped = await mcpRouteAccess(companyId, auth.companyToken!, requestedAgentId);
  if (scoped.response) return scoped.response;
  const agentId = scoped.access.agentId;
  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  try {
    await ensureTeamThread(companyId);
    const res = await claimNextTaskForAgent({
      companyId,
      agentId,
      strictOwnerRole,
      allowedRoles,
    });
    await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
    return NextResponse.json(res);
  } catch (routeError) {
    const message = routeError instanceof Error ? routeError.message : "Internal Server Error";
    const routeStatus = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status: routeStatus });
  }
}
