import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import packageJson from "@/../package.json" assert { type: "json" };

export async function GET(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const baseUrl = new URL(req.url).origin;
  const wsUrl = baseUrl.startsWith("https://")
    ? `${baseUrl.replace(/^https:/, "wss:")}/api/mcp/ws`
    : `${baseUrl.replace(/^http:/, "ws:")}/api/mcp/ws`;

  return NextResponse.json({
    ok: true,
    companyId: auth.companyToken!.companyId,
    serverTime: new Date().toISOString(),
    apiBaseUrl: baseUrl,
    wsUrl,
    emperorVersion: packageJson.version,
    docsUrl: `${baseUrl}/docs`,
    recommendedSkillVersion: "1.1.0",
    minimumBridgeVersion: "1.0.0",
    capabilities: {
      runtimeRegister: true,
      sessions: true,
      heartbeat: true,
      threads: true,
      checkpoints: true,
      resourcesIsShared: true,
      messagesAgentMentionsReply: true,
      docsVersioned: true,
      forceSharingInjection: true,
    },
  });
}
