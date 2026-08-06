import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken, OAuthError } from "@/lib/oauth";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";

// Called server-to-server by the MCP client after /authorize redirects back
// with a code — no browser session here, so this route stays public in
// src/proxy.ts's matcher. Accepts both JSON and the more common
// application/x-www-form-urlencoded (RFC 6749 form encoding).
export async function POST(req: NextRequest) {
    const ipLimit = consumeRateLimit({ key: `oauth:token:${getClientIp(req)}`, limit: 30, windowMs: 60_000 });
    if (!ipLimit.allowed) {
        return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }

    let params: Record<string, string>;
    const contentType = req.headers.get("content-type") || "";
    try {
        if (contentType.includes("application/json")) {
            params = await req.json();
        } else {
            const form = await req.formData();
            params = Object.fromEntries(form.entries()) as Record<string, string>;
        }
    } catch {
        return NextResponse.json({ error: "invalid_request", error_description: "Could not parse request body" }, { status: 400 });
    }

    const { grant_type, code, client_id, redirect_uri, code_verifier } = params;

    if (grant_type !== "authorization_code") {
        return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    if (!code || !client_id || !redirect_uri || !code_verifier) {
        return NextResponse.json({ error: "invalid_request", error_description: "code, client_id, redirect_uri, and code_verifier are required" }, { status: 400 });
    }

    try {
        const result = await exchangeCodeForToken({ code, clientId: client_id, redirectUri: redirect_uri, codeVerifier: code_verifier });
        return NextResponse.json({
            access_token: result.accessToken,
            token_type: "Bearer",
            expires_in: result.expiresIn,
            scope: result.scope,
        });
    } catch (err) {
        if (err instanceof OAuthError) {
            return NextResponse.json({ error: err.code, error_description: err.message }, { status: 400 });
        }
        console.error("OAuth token exchange error:", err);
        return NextResponse.json({ error: "server_error" }, { status: 500 });
    }
}
