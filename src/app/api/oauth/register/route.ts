import { NextRequest, NextResponse } from "next/server";
import { registerOAuthClient, OAuthError } from "@/lib/oauth";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";

// RFC 7591 — public/PKCE-only dynamic client registration. No client_secret
// is issued (see src/lib/oauth.ts's top comment): redirect_uri exact-match
// is the security boundary a secret would otherwise provide.
export async function POST(req: NextRequest) {
    const ipLimit = consumeRateLimit({ key: `oauth:register:${getClientIp(req)}`, limit: 20, windowMs: 60_000 });
    if (!ipLimit.allowed) {
        return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "invalid_client_metadata", error_description: "Body must be JSON" }, { status: 400 });
    }

    const { client_name, redirect_uris } = (body || {}) as { client_name?: unknown; redirect_uris?: unknown };

    try {
        const client = await registerOAuthClient({
            clientName: typeof client_name === "string" ? client_name : undefined,
            redirectUris: Array.isArray(redirect_uris) ? redirect_uris as string[] : [],
        });

        return NextResponse.json({
            client_id: client.clientId,
            client_name: client.clientName,
            redirect_uris: client.redirectUris,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code"],
            response_types: ["code"],
        }, { status: 201 });
    } catch (err) {
        if (err instanceof OAuthError) {
            return NextResponse.json({ error: err.code, error_description: err.message }, { status: 400 });
        }
        console.error("OAuth client registration error:", err);
        return NextResponse.json({ error: "server_error" }, { status: 500 });
    }
}
