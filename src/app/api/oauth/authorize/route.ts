import { NextRequest, NextResponse } from "next/server";
import { getOAuthClient, validateRedirectUri, createAuthorizationCode, OAuthError } from "@/lib/oauth";
import { requireRole, AuthError } from "@/lib/roles";

// The consent form's submit target. Deliberately NOT in src/proxy.ts's
// public matcher — this must run behind a real session so we know which
// user/company is granting access. Only the /authorize page (also
// protected) links here. The granted token is a company-wide mcp_full
// token, so consent requires the same admin role as minting one directly.
export async function POST(req: NextRequest) {
    let ctx;
    try {
        ctx = await requireRole("admin")();
    } catch (err) {
        if (err instanceof AuthError) return NextResponse.json({ error: "unauthorized" }, { status: err.statusCode });
        throw err;
    }
    const companyId = ctx.companyId;

    const form = await req.formData();
    const decision = form.get("decision");
    const clientId = String(form.get("client_id") || "");
    const redirectUri = String(form.get("redirect_uri") || "");
    const codeChallenge = String(form.get("code_challenge") || "");
    const codeChallengeMethod = String(form.get("code_challenge_method") || "");
    const state = String(form.get("state") || "");

    const client = await getOAuthClient(clientId);
    if (!client || !validateRedirectUri(client, redirectUri)) {
        return NextResponse.json({ error: "invalid_request", error_description: "Unknown client or redirect_uri mismatch" }, { status: 400 });
    }

    const redirectUrl = new URL(redirectUri);

    if (decision !== "approve") {
        redirectUrl.searchParams.set("error", "access_denied");
        if (state) redirectUrl.searchParams.set("state", state);
        return NextResponse.redirect(redirectUrl, 303);
    }

    try {
        const code = await createAuthorizationCode({
            clientId,
            userId: ctx.userId,
            companyId,
            redirectUri,
            codeChallenge,
            codeChallengeMethod,
        });
        redirectUrl.searchParams.set("code", code);
        if (state) redirectUrl.searchParams.set("state", state);
        return NextResponse.redirect(redirectUrl, 303);
    } catch (err) {
        if (err instanceof OAuthError) {
            redirectUrl.searchParams.set("error", err.code);
            if (state) redirectUrl.searchParams.set("state", state);
            return NextResponse.redirect(redirectUrl, 303);
        }
        console.error("OAuth authorize error:", err);
        return NextResponse.json({ error: "server_error" }, { status: 500 });
    }
}
