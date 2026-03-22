import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import {
  archiveProjectAgentProfile,
  getProjectAgentProfile,
  updateProjectAgentProfile,
} from "@/lib/project-agent-profiles";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; profileId: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const { projectId, profileId } = await params;
  const profile = await getProjectAgentProfile(companyId, projectId, profileId);

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return NextResponse.json({ profile });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; profileId: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const { projectId, profileId } = await params;
  const body = await req.json();
  const profile = await updateProjectAgentProfile({
    companyId,
    projectId,
    profileId,
    patch: {
      roleType: body.roleType,
      displayName: body.displayName,
      signature: body.signature,
      memorySeed: body.memorySeed,
      resourcePolicyJson: body.resourcePolicyJson,
    },
  });

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return NextResponse.json({ profile });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; profileId: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const { projectId, profileId } = await params;
  const profile = await archiveProjectAgentProfile(companyId, projectId, profileId);

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return NextResponse.json({ profile });
}
