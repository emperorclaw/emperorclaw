import { NextRequest } from "next/server";
import { getOAuthIssuerUrl } from "@/lib/env";

// RFC 9728 — the discovery entry point a spec-compliant MCP client follows
// from /mcp's 401 WWW-Authenticate header (see src/app/mcp/route.ts) before
// falling back to guessing conventional OAuth paths.
export async function GET(req: NextRequest) {
    const origin = getOAuthIssuerUrl(req);
    return Response.json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
    });
}
