import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { createProjectAgentProfile, listProjectAgentProfiles } from "@/lib/project-agent-profiles";

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
  const profiles = await listProjectAgentProfiles(companyId, projectId);
  return NextResponse.json({ profiles });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const companyId = auth.companyToken!.companyId;
    const { projectId } = await params;
    const body = await req.json();

    if (!body.agentId) {
      return NextResponse.json({ error: "agentId is required" }, { status: 400 });
    }

    const profile = await createProjectAgentProfile({
      companyId,
      projectId,
      agentId: await resolveAgentId(companyId, body.agentId),
      roleType: body.roleType || "worker",
      displayName: body.displayName || null,
      signature: body.signature || null,
      memorySeed: body.memorySeed || null,
      resourcePolicyJson: body.resourcePolicyJson || {},
    });

    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const statusCode = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}
