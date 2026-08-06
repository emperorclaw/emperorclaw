import { randomBytes, createHash } from "crypto";
import { db } from "@/db";
import { oauthClients, oauthAuthorizationCodes, companyTokens } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes, single-use
const ACCESS_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // matches mcp_full company_tokens TTL elsewhere

export class OAuthError extends Error {
    constructor(public code: string, message: string) {
        super(message);
    }
}

// --- Dynamic client registration (RFC 7591) ---------------------------------
// Public/PKCE-only clients: no client_secret. redirect_uri exact-match is the
// real security boundary a confidential client's secret would otherwise be.

export type RegisteredClient = {
    clientId: string;
    clientName: string | null;
    redirectUris: string[];
};

export async function registerOAuthClient(input: { clientName?: string; redirectUris: string[] }): Promise<RegisteredClient> {
    if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
        throw new OAuthError("invalid_client_metadata", "redirect_uris is required and must be non-empty");
    }
    for (const uri of input.redirectUris) {
        if (typeof uri !== "string" || !uri.startsWith("https://")) {
            throw new OAuthError("invalid_redirect_uri", "Each redirect_uri must be an https:// URL");
        }
    }

    const clientId = `oc_${randomBytes(16).toString("hex")}`;
    await db.insert(oauthClients).values({
        clientId,
        clientName: input.clientName || null,
        redirectUris: input.redirectUris,
    });

    return { clientId, clientName: input.clientName || null, redirectUris: input.redirectUris };
}

export async function getOAuthClient(clientId: string): Promise<RegisteredClient | null> {
    const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
    if (!row) return null;
    return { clientId: row.clientId, clientName: row.clientName, redirectUris: row.redirectUris };
}

export function validateRedirectUri(client: RegisteredClient, redirectUri: string): boolean {
    return client.redirectUris.includes(redirectUri);
}

// --- PKCE (RFC 7636) ---------------------------------------------------------
// Only S256 is accepted — "plain" is disallowed per OAuth 2.1 best practice.

export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
    const computed = createHash("sha256").update(codeVerifier).digest("base64url");
    return computed === codeChallenge;
}

// --- Authorization code -------------------------------------------------------

export async function createAuthorizationCode(input: {
    clientId: string;
    userId: string;
    companyId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
}): Promise<string> {
    if (input.codeChallengeMethod !== "S256") {
        throw new OAuthError("invalid_request", "code_challenge_method must be S256");
    }

    const rawCode = `oac_${randomBytes(32).toString("hex")}`;
    const codeHash = createHash("sha256").update(rawCode).digest("hex");

    await db.insert(oauthAuthorizationCodes).values({
        codeHash,
        clientId: input.clientId,
        userId: input.userId,
        companyId: input.companyId,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: input.codeChallengeMethod,
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
    });

    return rawCode;
}

// --- Token exchange ------------------------------------------------------------
// Verifies the authorization code + PKCE, then mints a REAL company_tokens
// row — the exact same token type /mcp already accepts via verifyMcpToken,
// and the exact same mint shape as src/app/api/settings/tokens/route.ts, so
// the result shows up in Settings -> Tokens and is revocable there with no
// new UI. This function is the entire reason the OAuth flow exists.

export async function exchangeCodeForToken(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
}): Promise<{ accessToken: string; expiresIn: number; scope: string }> {
    const codeHash = createHash("sha256").update(input.code).digest("hex");

    const [row] = await db.select().from(oauthAuthorizationCodes)
        .where(and(eq(oauthAuthorizationCodes.codeHash, codeHash), isNull(oauthAuthorizationCodes.consumedAt)))
        .limit(1);

    if (!row) {
        throw new OAuthError("invalid_grant", "Authorization code is invalid, expired, or already used");
    }
    if (row.expiresAt.getTime() < Date.now()) {
        throw new OAuthError("invalid_grant", "Authorization code has expired");
    }
    if (row.clientId !== input.clientId) {
        throw new OAuthError("invalid_grant", "client_id does not match the code that was issued");
    }
    if (row.redirectUri !== input.redirectUri) {
        throw new OAuthError("invalid_grant", "redirect_uri does not match the code that was issued");
    }
    if (!verifyPkce(input.codeVerifier, row.codeChallenge)) {
        throw new OAuthError("invalid_grant", "code_verifier does not match code_challenge");
    }

    // Mark consumed before minting the token — a raced double-submit should
    // never be able to mint two tokens from one code.
    const marked = await db.update(oauthAuthorizationCodes)
        .set({ consumedAt: new Date() })
        .where(and(eq(oauthAuthorizationCodes.id, row.id), isNull(oauthAuthorizationCodes.consumedAt)))
        .returning({ id: oauthAuthorizationCodes.id });
    if (marked.length === 0) {
        throw new OAuthError("invalid_grant", "Authorization code was already used");
    }

    const client = await getOAuthClient(row.clientId);
    const rawToken = `ec_${randomBytes(24).toString("hex")}`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    await db.insert(companyTokens).values({
        companyId: row.companyId,
        tokenHash,
        name: `oauth:${client?.clientName || row.clientId}`,
        scope: "mcp_full",
    });

    return { accessToken: rawToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), scope: "mcp_full" };
}
