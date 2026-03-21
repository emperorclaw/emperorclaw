import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";

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
    capabilities: {
      runtimeRegister: true,
      sessions: true,
      heartbeat: true,
      threads: true,
      checkpoints: true,
    },
  });
}
