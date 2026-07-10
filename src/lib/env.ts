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
    }

    // Production safety net — self-hosters should set APP_URL or NEXTAUTH_URL explicitly.
    // This fallback preserves backward compatibility for the existing deployment.
    return "https://emperorclaw.malecu.eu";
}
