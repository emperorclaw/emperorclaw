/**
 * Deployment mode — architecturally constant, read once at process startup (NFR-4).
 * "self-hosted" is the default for the open-source release.
 * "cloud" must be explicitly opted into.
 */
export const DEPLOYMENT_MODE: "self-hosted" | "cloud" =
    process.env.DEPLOYMENT_MODE === "cloud" ? "cloud" : "self-hosted";

export function requireEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === null || value === "") {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export function optionalEnv(name: string): string | undefined {
    const value = process.env[name];
    if (value === undefined || value === null) {
        return undefined;
    }
    return value === "" ? undefined : value;
}

function normalizeBaseUrl(url: string): string {
    return url.trim().replace(/\/+$/, "");
}

export function getAppUrl(request?: {
    nextUrl?: { origin?: string };
    headers?: { get(name: string): string | null };
}): string {
    const configured =
        optionalEnv("APP_URL") ||
        optionalEnv("NEXTAUTH_URL") ||
        optionalEnv("EMPEROR_PUBLIC_URL");

    if (configured) {
        return normalizeBaseUrl(configured);
    }

    if (process.env.NODE_ENV !== "production") {
        const requestOrigin = request?.nextUrl?.origin;
        if (requestOrigin) {
            return normalizeBaseUrl(requestOrigin);
        }

        const headers = request?.headers;
        const host = headers?.get("x-forwarded-host") || headers?.get("host");
        if (host) {
            const proto = headers?.get("x-forwarded-proto") || "http";
            return normalizeBaseUrl(`${proto}://${host}`);
        }

        return "http://localhost:3000";
    }

    throw new Error(
        "Cannot determine the app's public URL: set APP_URL (or NEXTAUTH_URL) in your environment."
    );
}

/**
 * Origin to advertise in OAuth discovery metadata (.well-known/*) and the
 * /mcp WWW-Authenticate hint. Deliberately does NOT reuse getAppUrl()'s
 * "configured env var always wins" priority: a reverse-proxied self-hosted
 * install very commonly leaves APP_URL/NEXTAUTH_URL at docker-compose.yml's
 * literal default (http://localhost:3000) since that value only used to
 * matter for internal purposes. For OAuth specifically that default is
 * actively wrong — it gets baked into discovery metadata a REAL external
 * client (e.g. claude.ai) then tries to reach and can't, breaking
 * registration with an opaque error. Trust the actual inbound request's
 * forwarded headers first — a well-behaved reverse proxy (Caddy, nginx,
 * Cloudflare Tunnel) always sets these correctly regardless of whatever
 * APP_URL happens to be — and only fall back to the configured value if the
 * request carries no host information at all (never happens over real HTTP).
 */
export function getOAuthIssuerUrl(request: {
    nextUrl?: { origin?: string };
    headers: { get(name: string): string | null };
}): string {
    const forwardedHost = request.headers.get("x-forwarded-host");
    const host = forwardedHost || request.headers.get("host");
    if (host) {
        const proto = request.headers.get("x-forwarded-proto") || (forwardedHost ? "https" : "http");
        return normalizeBaseUrl(`${proto}://${host}`);
    }
    return getAppUrl(request);
}
