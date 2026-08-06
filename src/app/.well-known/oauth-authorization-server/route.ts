import { NextRequest } from "next/server";
import { getOAuthIssuerUrl } from "@/lib/env";

// RFC 8414 — lets an MCP client discover our OAuth endpoints instead of
// guessing conventional paths (see src/lib/oauth.ts for why this whole
// server exists: to mint a normal company_tokens Bearer token for /mcp).
export async function GET(req: NextRequest) {
    const origin = getOAuthIssuerUrl(req);
    return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/api/oauth/token`,
        registration_endpoint: `${origin}/api/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp_full"],
    });
}
